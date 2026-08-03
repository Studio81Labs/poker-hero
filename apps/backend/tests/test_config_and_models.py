from pathlib import Path
from typing import Any, get_type_hints

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.models import (
    Card,
    CanonicalState,
    DetectedState,
    ParserResult,
    RecommendationAction,
    RecommendationResult,
    TrainingDecisionRequest,
)


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
    assert settings.postflop_solver_max_iterations == 400
    assert settings.postflop_solver_target_exploitability == 0.01
    assert settings.postflop_solver_max_memory_mb == 768
    assert settings.postflop_solver_bet_sizes == "70%"
    assert settings.postflop_solver_raise_sizes == "2.5x"
    assert settings.max_upload_bytes == 10 * 1024 * 1024
    assert settings.max_dataset_upload_bytes == 100 * 1024 * 1024
    assert settings.max_backup_upload_bytes == 100 * 1024 * 1024
    assert settings.cors_origins == ["http://localhost:5173"]
    assert settings.proxy_shared_secret is None
    assert settings.external_parser_bearer_token is None
    assert settings.external_provider_bearer_token is None
    assert settings.llm_advice_bearer_token is None
    assert settings.external_request_timeout_seconds == 60


def test_settings_reads_poker_prefixed_provider_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POKER_PARSER_PROVIDER", "external")
    monkeypatch.setenv("POKER_RECOMMENDATION_PROVIDER", "solver")
    monkeypatch.setenv("POKER_LOCAL_SOLVER_ENGINE", "local_ev")
    monkeypatch.setenv("POKER_EXTERNAL_PROVIDER_BEARER_TOKEN", "solver-token")
    monkeypatch.setenv("POKER_EXTERNAL_REQUEST_TIMEOUT_SECONDS", "12.5")

    settings = Settings()

    assert settings.parser_provider == "external"
    assert settings.recommendation_provider == "solver"
    assert settings.local_solver_engine == "local_ev"
    assert settings.external_provider_bearer_token is not None
    assert settings.external_provider_bearer_token.get_secret_value() == "solver-token"
    assert settings.external_request_timeout_seconds == 12.5


def test_application_settings_loader_reads_dotenv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text(
        "POKER_PARSER_PROVIDER=ocr_cv\n"
        "POKER_POSTFLOP_SOLVER_MAX_ITERATIONS=17\n"
        "POKER_POSTFLOP_SOLVER_BET_SIZES=50%,100%\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    get_settings.cache_clear()

    try:
        settings = get_settings()
    finally:
        get_settings.cache_clear()

    assert settings.parser_provider == "ocr_cv"
    assert settings.postflop_solver_max_iterations == 17
    assert settings.postflop_solver_bet_sizes == "50%,100%"


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
    with pytest.raises(ValidationError):
        Settings(external_request_timeout_seconds=0)


def test_settings_rejects_invalid_postflop_solver_limits() -> None:
    with pytest.raises(ValidationError):
        Settings(postflop_solver_max_iterations=0)
    with pytest.raises(ValidationError):
        Settings(postflop_solver_target_exploitability=1.1)
    with pytest.raises(ValidationError):
        Settings(postflop_solver_max_memory_mb=0)
    with pytest.raises(ValidationError):
        Settings(postflop_solver_rake_rate=-0.01)


def test_settings_rejects_non_positive_max_upload_bytes() -> None:
    with pytest.raises(ValidationError):
        Settings(max_upload_bytes=0)
    with pytest.raises(ValidationError):
        Settings(max_dataset_upload_bytes=0)
    with pytest.raises(ValidationError):
        Settings(max_backup_upload_bytes=0)


def test_settings_normalizes_and_validates_proxy_shared_secret() -> None:
    assert Settings(proxy_shared_secret="").proxy_shared_secret is None
    secret = Settings(proxy_shared_secret=f"  {'s' * 32}  ").proxy_shared_secret

    assert secret is not None
    assert secret.get_secret_value() == "s" * 32

    with pytest.raises(ValidationError):
        Settings(proxy_shared_secret="too-short")


def test_settings_normalizes_and_masks_external_bearer_tokens() -> None:
    assert Settings(external_parser_bearer_token="").external_parser_bearer_token is None
    token = Settings(external_parser_bearer_token="  parser-token  ").external_parser_bearer_token

    assert token is not None
    assert token.get_secret_value() == "parser-token"
    assert "parser-token" not in repr(token)

    with pytest.raises(ValidationError, match="must not contain whitespace"):
        Settings(external_parser_bearer_token="invalid token")
    with pytest.raises(ValidationError, match="ASCII"):
        Settings(external_parser_bearer_token="töken")


@pytest.mark.parametrize(
    ("url_field", "token_field"),
    [
        ("external_parser_url", "external_parser_bearer_token"),
        ("external_provider_url", "external_provider_bearer_token"),
        ("llm_advice_url", "llm_advice_bearer_token"),
    ],
)
def test_settings_require_https_for_authenticated_external_services(
    url_field: str,
    token_field: str,
) -> None:
    token = "must-not-appear-in-validation-output"

    with pytest.raises(ValidationError, match="must use HTTPS") as exc_info:
        Settings(**{url_field: "http://service.example/api", token_field: token})

    assert token not in str(exc_info.value)


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


def test_detected_state_rejects_unknown_facing_action() -> None:
    with pytest.raises(ValidationError):
        DetectedState(facing_action="call")


@pytest.mark.parametrize("action", ["fold", "check", "call"])
def test_recommendation_rejects_sizing_for_non_wager_action(
    action: RecommendationAction,
) -> None:
    with pytest.raises(
        ValidationError,
        match="Sizing is only valid for bet or raise recommendations",
    ):
        RecommendationResult(
            action=action,
            sizing=2.5,
            confidence=0.8,
            explanation="Malformed recommendation",
        )


@pytest.mark.parametrize(
    "model",
    [RecommendationResult, TrainingDecisionRequest],
)
def test_action_line_rejects_nonfinite_sizing(model: type[Any]) -> None:
    values: dict[str, Any] = {"action": "raise", "sizing": float("inf")}
    if model is RecommendationResult:
        values.update(confidence=0.8, explanation="Malformed recommendation")

    with pytest.raises(ValidationError, match="finite number"):
        model(**values)


@pytest.mark.parametrize(
    "model",
    [RecommendationResult, TrainingDecisionRequest],
)
def test_action_line_rejects_zero_wager_sizing(model: type[Any]) -> None:
    values: dict[str, Any] = {"action": "raise", "sizing": 0}
    if model is RecommendationResult:
        values.update(confidence=0.8, explanation="Malformed recommendation")

    with pytest.raises(ValidationError, match="greater than 0"):
        model(**values)


@pytest.mark.parametrize(
    ("model", "sizing"),
    [
        (RecommendationResult, True),
        (RecommendationResult, "7.5"),
        (TrainingDecisionRequest, True),
        (TrainingDecisionRequest, "7.5"),
    ],
)
def test_action_line_rejects_coerced_wager_sizing(
    model: type[Any],
    sizing: object,
) -> None:
    values: dict[str, Any] = {"action": "raise", "sizing": sizing}
    if model is RecommendationResult:
        values.update(confidence=0.8, explanation="Malformed recommendation")

    with pytest.raises(ValidationError, match="valid number"):
        model(**values)


@pytest.mark.parametrize("model", [RecommendationResult, TrainingDecisionRequest])
def test_action_line_accepts_integer_wager_sizing(model: type[Any]) -> None:
    values: dict[str, Any] = {"action": "raise", "sizing": 8}
    if model is RecommendationResult:
        values.update(confidence=0.8, explanation="Valid recommendation")

    result = model(**values)

    assert result.sizing == 8.0


def test_canonical_state_rejects_non_positive_preflop_open_size() -> None:
    with pytest.raises(ValidationError):
        CanonicalState(preflop_open_size=0)


def test_canonical_state_copies_detected_values() -> None:
    detected = DetectedState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("Kd")],
        board_cards=[Card.from_code("Qs"), Card.from_code("Jc"), Card.from_code("2h")],
        pot_size=12.5,
        current_bet=2.5,
        hero_stack=97.5,
        effective_stack=96.0,
        players_in_hand=3,
        hero_position="button",
        preflop_opener_position="cutoff",
        preflop_open_size=2.5,
        street="flop",
        facing_action="bet",
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
    assert canonical.hero_stack == 97.5
    assert canonical.facing_action == "bet"
    assert canonical.preflop_opener_position == "cutoff"
    assert canonical.preflop_open_size == 2.5
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
