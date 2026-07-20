from pathlib import Path
from typing import Any, get_type_hints

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.models import Card, CanonicalState, DetectedState, ParserResult, RecommendationResult


def test_settings_defaults_use_local_training_backends(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)

    assert settings.data_dir == tmp_path
    assert settings.parser_provider == "mock"
    assert settings.parser_layout_profile == "generic"
    assert settings.parser_auto_approve_enabled is False
    assert settings.recommendation_provider == "rule_based"
    assert settings.local_solver_engine == "postflop_solver"
    assert settings.local_solver_timeout_seconds == 120
    assert settings.postflop_solver_fallback_enabled is True
    assert settings.max_upload_bytes == 10 * 1024 * 1024
    assert settings.cors_origins == ["http://localhost:5173"]


def test_settings_reads_poker_prefixed_provider_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POKER_PARSER_PROVIDER", "external")
    monkeypatch.setenv("POKER_RECOMMENDATION_PROVIDER", "solver")
    monkeypatch.setenv("POKER_LOCAL_SOLVER_ENGINE", "local_ev")

    settings = Settings()

    assert settings.parser_provider == "external"
    assert settings.recommendation_provider == "solver"
    assert settings.local_solver_engine == "local_ev"


def test_application_settings_loader_reads_dotenv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("POKER_PARSER_PROVIDER=ocr_cv\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    get_settings.cache_clear()

    try:
        settings = get_settings()
    finally:
        get_settings.cache_clear()

    assert settings.parser_provider == "ocr_cv"


def test_settings_parses_thresholds_from_json_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "POKER_PARSER_AUTO_APPROVE_THRESHOLDS",
        '{"hero_cards": 0.9, "board_cards": 0.85}',
    )

    settings = Settings()

    assert settings.parser_auto_approve_thresholds == {
        "hero_cards": 0.9,
        "board_cards": 0.85,
    }


def test_settings_rejects_invalid_auto_approve_threshold() -> None:
    with pytest.raises(ValidationError):
        Settings(parser_auto_approve_thresholds={"hero_cards": 1.5})


def test_settings_rejects_non_positive_solver_timeout() -> None:
    with pytest.raises(ValidationError):
        Settings(local_solver_timeout_seconds=0)


def test_settings_rejects_non_positive_max_upload_bytes() -> None:
    with pytest.raises(ValidationError):
        Settings(max_upload_bytes=0)


def test_card_from_code_normalizes_rank_and_suit() -> None:
    card = Card.from_code("Ah")

    assert card.rank == "A"
    assert card.suit == "hearts"
    assert card.code == "Ah"


def test_card_rejects_unknown_rank() -> None:
    with pytest.raises(ValidationError):
        Card(rank="1", suit="hearts")


def test_card_schema_exposes_rank_and_suit_enums() -> None:
    schema = Card.model_json_schema()

    assert schema["properties"]["rank"]["enum"] == [
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "T",
        "J",
        "Q",
        "K",
        "A",
    ]
    assert schema["properties"]["suit"]["enum"] == ["clubs", "diamonds", "hearts", "spades"]


def test_detected_state_rejects_too_many_hero_cards() -> None:
    with pytest.raises(ValidationError):
        DetectedState(
            hero_cards=[
                Card.from_code("Ah"),
                Card.from_code("Kd"),
                Card.from_code("Qs"),
            ]
        )


def test_detected_state_rejects_too_many_board_cards() -> None:
    with pytest.raises(ValidationError):
        DetectedState(
            board_cards=[
                Card.from_code("Ah"),
                Card.from_code("Kd"),
                Card.from_code("Qs"),
                Card.from_code("Jc"),
                Card.from_code("2h"),
                Card.from_code("3d"),
            ]
        )


def test_canonical_state_rejects_duplicate_cards_across_state() -> None:
    with pytest.raises(ValidationError):
        CanonicalState(
            hero_cards=[Card.from_code("Ah")],
            board_cards=[Card.from_code("Ah")],
        )


def test_canonical_state_copies_detected_values() -> None:
    detected = DetectedState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("Kd")],
        board_cards=[Card.from_code("Qs"), Card.from_code("Jc"), Card.from_code("2h")],
        pot_size=12.5,
        current_bet=2.5,
        effective_stack=96.0,
        players_in_hand=3,
        hero_position="button",
        street="flop",
        action_context="Cutoff bet 2.5 into 12.5",
    )
    parser_result = ParserResult(
        state=detected,
        confidences={"hero_cards": 0.99, "board_cards": 0.98, "pot_size": 0.92, "street": 1.0},
        warnings=[],
        raw={"provider": "mock"},
    )

    canonical = CanonicalState.from_parser_result(parser_result)

    assert canonical.hero_cards == detected.hero_cards
    assert canonical.board_cards == detected.board_cards
    assert canonical.pot_size == 12.5
    assert canonical.user_approved is False


def test_canonical_state_does_not_share_cards_with_detected_state() -> None:
    detected = DetectedState(hero_cards=[Card.from_code("Ah")])
    parser_result = ParserResult(state=detected)

    canonical = CanonicalState.from_parser_result(parser_result)
    detected.hero_cards[0].rank = "K"

    assert canonical.hero_cards[0].code == "Ah"


def test_raw_metadata_types_are_string_keyed_any_dicts() -> None:
    assert get_type_hints(ParserResult)["raw"] == dict[str, Any]
    assert get_type_hints(RecommendationResult)["raw"] == dict[str, Any]
