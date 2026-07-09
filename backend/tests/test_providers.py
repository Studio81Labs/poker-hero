import sys
from pathlib import Path

import pytest

from app.config import Settings
from app.models import CanonicalState, Card, RecommendationRequest
from app.providers.base import ProviderConfigurationError, missing_required_fields
from app.providers.registry import build_provider


def approved_state() -> CanonicalState:
    return CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("Kd")],
        board_cards=[Card.from_code("Qs"), Card.from_code("Jc"), Card.from_code("2h")],
        pot_size=12.5,
        current_bet=2.5,
        effective_stack=96.0,
        players_in_hand=3,
        hero_position="button",
        street="flop",
        action_context="Cutoff bet 2.5 into 12.5",
        user_approved=True,
    )


def test_mock_provider_returns_training_recommendation(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="mock"))
    request = RecommendationRequest(state=approved_state(), provider=provider.name)

    result = provider.recommend(request)

    assert result.action == "raise"
    assert result.sizing == 7.5
    assert result.confidence == 0.72
    assert "training" in result.explanation.lower()
    assert result.raw["provider"] == "mock"


def test_required_field_validation_reports_missing_values() -> None:
    state = CanonicalState(street="flop", user_approved=True)

    assert missing_required_fields(state, ["hero_cards", "street"]) == ["hero_cards"]


def test_registry_rejects_unknown_provider(tmp_path: Path) -> None:
    with pytest.raises(ProviderConfigurationError, match="Unknown recommendation provider"):
        build_provider(Settings(data_dir=tmp_path, recommendation_provider="missing"))


def test_local_solver_requires_command(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="local_solver"))
    request = RecommendationRequest(state=approved_state(), provider=provider.name)

    with pytest.raises(ProviderConfigurationError, match="POKER_LOCAL_SOLVER_COMMAND"):
        provider.recommend(request)


def test_local_solver_reads_json_response(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text(
        "import json, sys\n"
        "json.loads(sys.stdin.read())\n"
        "print(json.dumps({"
        "'action': 'call', "
        "'sizing': None, "
        "'confidence': 0.64, "
        "'explanation': 'Local command response', "
        "'raw': {'provider': 'local_solver'}"
        "}))\n"
    )
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    result = provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))

    assert result.action == "call"
    assert result.raw["provider"] == "local_solver"
