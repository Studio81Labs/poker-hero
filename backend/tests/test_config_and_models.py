from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.models import Card, CanonicalState, DetectedState, ParserResult


def test_settings_defaults_use_mock_backends(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)

    assert settings.data_dir == tmp_path
    assert settings.parser_provider == "mock"
    assert settings.parser_layout_profile == "generic"
    assert settings.parser_auto_approve_enabled is False
    assert settings.recommendation_provider == "mock"
    assert settings.cors_origins == ["http://localhost:5173"]


def test_card_from_code_normalizes_rank_and_suit() -> None:
    card = Card.from_code("Ah")

    assert card.rank == "A"
    assert card.suit == "hearts"
    assert card.code == "Ah"


def test_card_rejects_unknown_rank() -> None:
    with pytest.raises(ValidationError):
        Card(rank="1", suit="hearts")


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
