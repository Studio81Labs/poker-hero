import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.models import CanonicalState, Card, RecommendationRequest
from app.providers.base import ProviderConfigurationError, ProviderError, missing_required_fields
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


def test_mock_provider_uses_rule_based_training_recommendation(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="mock"))
    request = RecommendationRequest(state=approved_state(), provider=provider.name)

    result = provider.recommend(request)

    assert result.action == "call"
    assert result.sizing is None
    assert "rule-based training recommendation" in result.explanation.lower()
    assert result.raw["provider"] == "mock"
    assert result.raw["engine"] == "rule_based_training_v2"
    assert "equity" in result.raw


def test_rule_based_provider_checks_missed_flop_with_no_bet(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="rule_based"))
    state = CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("9c")],
        board_cards=[Card.from_code("Th"), Card.from_code("Kd"), Card.from_code("4c")],
        pot_size=10,
        current_bet=0,
        effective_stack=16.1,
        players_in_hand=4,
        street="flop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.action == "check"
    assert result.sizing is None
    assert result.raw["provider"] == "rule_based"
    assert result.raw["hand_category"] == "high card"
    assert result.raw["equity"]["iterations"] > 0


def test_rule_based_provider_controls_weak_top_pair_multiway(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="rule_based"))
    state = CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("7d")],
        board_cards=[Card.from_code("As"), Card.from_code("8s"), Card.from_code("Qh")],
        pot_size=3,
        current_bet=0,
        effective_stack=96.5,
        players_in_hand=3,
        street="flop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.action == "check"
    assert result.sizing is None
    assert result.raw["hand_category"] == "one pair"
    assert result.raw["top_pair_kicker"] == 7
    assert result.raw["wet_board"] is True


def test_rule_based_provider_folds_weak_offsuit_preflop_call(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="rule_based"))
    state = CanonicalState(
        hero_cards=[Card.from_code("Kc"), Card.from_code("7d")],
        pot_size=4.5,
        current_bet=2.5,
        effective_stack=38.3,
        players_in_hand=3,
        street="preflop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.action == "fold"
    assert result.sizing is None
    assert result.raw["provider"] == "rule_based"
    assert result.raw["realized_equity"] < result.raw["required_equity"]


def test_rule_based_provider_defends_ace_high_heads_up_preflop(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="rule_based"))
    state = CanonicalState(
        hero_cards=[Card.from_code("7d"), Card.from_code("Ah")],
        pot_size=3.5,
        current_bet=1.5,
        effective_stack=100.4,
        players_in_hand=2,
        street="preflop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.action == "call"
    assert result.sizing is None
    assert result.raw["realized_equity"] > result.raw["required_equity"]


def test_rule_based_provider_bets_strong_made_hand(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="rule_based"))
    state = CanonicalState(
        hero_cards=[Card.from_code("Kh"), Card.from_code("Ks")],
        board_cards=[Card.from_code("Kd"), Card.from_code("7c"), Card.from_code("2h")],
        pot_size=10,
        current_bet=0,
        effective_stack=80,
        players_in_hand=2,
        street="flop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.action == "bet"
    assert result.sizing == 7
    assert "strong made hand" in result.explanation.lower()


def test_required_field_validation_reports_missing_values() -> None:
    state = CanonicalState(street="flop", user_approved=True)

    assert missing_required_fields(state, ["hero_cards", "street"]) == ["hero_cards"]


def test_required_field_validation_treats_blank_strings_as_missing() -> None:
    state = CanonicalState(hero_position="  ", street="flop", user_approved=True)

    assert missing_required_fields(state, ["hero_position", "street"]) == ["hero_position"]


def test_required_field_validation_rejects_unknown_field() -> None:
    state = CanonicalState(street="flop", user_approved=True)

    with pytest.raises(ProviderConfigurationError, match="Unknown required field: missing_field"):
        missing_required_fields(state, ["missing_field"])
    with pytest.raises(ProviderConfigurationError, match="Unknown required field: model_dump"):
        missing_required_fields(state, ["model_dump"])


def test_registry_rejects_unknown_provider(tmp_path: Path) -> None:
    with pytest.raises(ProviderConfigurationError, match="Unknown recommendation provider"):
        build_provider(Settings(data_dir=tmp_path, recommendation_provider="missing"))


def test_local_solver_uses_bundled_solver_when_command_is_missing(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="local_solver"))
    request = RecommendationRequest(state=approved_state(), provider=provider.name)

    result = provider.recommend(request)

    assert result.action == "call"
    assert result.raw["provider"] == "local_solver"
    assert result.raw["engine"] == "local_ev_solver_v1"
    assert result.raw["equity"]["method"] == "monte_carlo_range"
    assert len(result.raw["candidates"]) >= 2
    assert "solver compared candidate actions" in result.explanation.lower()


def test_local_solver_uses_bundled_solver_when_command_is_blank(tmp_path: Path) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command="   ",
        )
    )

    result = provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))

    assert result.raw["provider"] == "local_solver"
    assert result.raw["engine"] == "local_ev_solver_v1"


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


def test_local_solver_nonzero_exit_includes_return_code_and_output(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text("import sys\nprint('solver exploded', file=sys.stderr)\nsys.exit(7)\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="return code 7.*solver exploded"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_local_solver_nonzero_exit_falls_back_to_stdout(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text("import sys\nprint('stdout failure')\nsys.exit(9)\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="return code 9.*stdout failure"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_local_solver_startup_error_raises_provider_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_run(*args: object, **kwargs: object) -> object:
        raise OSError("command missing")

    monkeypatch.setattr("subprocess.run", fake_run)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command="solver",
        )
    )

    with pytest.raises(ProviderError, match="could not be started.*command missing"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_local_solver_timeout_raises_provider_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(*args: object, **kwargs: object) -> object:
        raise subprocess.TimeoutExpired(cmd=["solver"], timeout=30.0)

    monkeypatch.setattr("subprocess.run", fake_run)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command="solver",
        )
    )

    with pytest.raises(ProviderError, match="timed out"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_local_solver_invalid_json_raises_provider_error(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text("print('not-json')\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid JSON"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_local_solver_invalid_payload_raises_provider_error(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text("print('{\"action\": \"jam\"}')\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_external_solver_posts_canonical_json_body(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    request = httpx.Request("POST", "https://solver.example/recommend")
    captured: dict[str, object] = {}

    def fake_post(url: str, *, json: dict[str, object], timeout: float) -> httpx.Response:
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return httpx.Response(
            200,
            json={
                "action": "bet",
                "sizing": 8.0,
                "confidence": 0.81,
                "explanation": "External solver response",
                "raw": {"provider": "external_solver"},
            },
            request=request,
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="external_solver",
            external_provider_url="https://solver.example/recommend",
        )
    )

    result = provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))

    assert result.action == "bet"
    assert result.raw["provider"] == "external_solver"
    assert captured == {
        "url": "https://solver.example/recommend",
        "json": {
            "state": {
                "hero_cards": [
                    {"rank": "A", "suit": "hearts"},
                    {"rank": "K", "suit": "diamonds"},
                ],
                "board_cards": [
                    {"rank": "Q", "suit": "spades"},
                    {"rank": "J", "suit": "clubs"},
                    {"rank": "2", "suit": "hearts"},
                ],
                "pot_size": 12.5,
                "current_bet": 2.5,
                "effective_stack": 96.0,
                "players_in_hand": 3,
                "hero_position": "button",
                "street": "flop",
                "action_context": "Cutoff bet 2.5 into 12.5",
                "user_approved": True,
            },
            "provider": "external_solver",
        },
        "timeout": 60.0,
    }


def test_external_solver_requires_url(tmp_path: Path) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="external_solver",
            external_provider_url=None,
        )
    )

    with pytest.raises(ProviderConfigurationError, match="POKER_EXTERNAL_PROVIDER_URL"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_llm_advice_requires_url(tmp_path: Path) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="llm_advice",
            llm_advice_url=None,
        )
    )

    with pytest.raises(ProviderConfigurationError, match="POKER_LLM_ADVICE_URL"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_http_provider_non_success_status_raises_provider_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = httpx.Request("POST", "https://solver.example/recommend")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"}, request=request)

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="external_solver",
            external_provider_url="https://solver.example/recommend",
        )
    )

    with pytest.raises(ProviderError, match="status 503"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_http_provider_request_failure_raises_provider_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        raise httpx.RequestError("connection refused")

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="external_solver",
            external_provider_url="https://solver.example/recommend",
        )
    )

    with pytest.raises(ProviderError, match="external_solver request failed"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_http_provider_invalid_json_raises_provider_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = httpx.Request("POST", "https://solver.example/recommend")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(200, content=b"not-json", request=request)

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="external_solver",
            external_provider_url="https://solver.example/recommend",
        )
    )

    with pytest.raises(ProviderError, match="invalid JSON"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


def test_http_provider_invalid_payload_raises_provider_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = httpx.Request("POST", "https://solver.example/recommend")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(200, json={"action": "jam"}, request=request)

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="external_solver",
            external_provider_url="https://solver.example/recommend",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))
