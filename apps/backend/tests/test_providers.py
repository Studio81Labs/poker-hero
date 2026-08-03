import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.models import CanonicalState, Card, RecommendationRequest
from app.providers.base import (
    ProviderConfigurationError,
    ProviderError,
    ProviderInputError,
    missing_required_fields,
)
from app.providers.registry import build_provider


def approved_state() -> CanonicalState:
    return CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("Kd")],
        board_cards=[Card.from_code("Qs"), Card.from_code("Jc"), Card.from_code("2h")],
        pot_size=12.5,
        current_bet=2.5,
        hero_stack=97.5,
        effective_stack=96.0,
        players_in_hand=3,
        hero_position="button",
        street="flop",
        facing_action="bet",
        action_context="Cutoff bet 2.5 into 12.5",
        user_approved=True,
    )


def heads_up_postflop_state() -> CanonicalState:
    state = approved_state().model_copy(deep=True)
    state.players_in_hand = 2
    state.hero_position = "IP"
    return state


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
    assert result.raw["requested_engine"] == "postflop_solver"
    assert "heads-up postflop" in result.raw["fallback_reason"]
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

    result = provider.recommend(
        RecommendationRequest(state=approved_state(), provider=provider.name)
    )

    assert result.raw["provider"] == "local_solver"
    assert result.raw["engine"] == "local_ev_solver_v1"
    assert result.raw["requested_engine"] == "postflop_solver"


def test_local_solver_can_select_bundled_ev_engine(tmp_path: Path) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_engine="local_ev",
        )
    )

    result = provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))

    assert result.raw["engine"] == "local_ev_solver_v1"
    assert "requested_engine" not in result.raw


def test_local_ev_selection_bypasses_supported_preflop_chart(tmp_path: Path) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_engine="local_ev",
        )
    )
    state = CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("2h")],
        pot_size=1.5,
        current_bet=0,
        effective_stack=100,
        players_in_hand=6,
        hero_position="button",
        street="preflop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.raw["engine"] == "local_ev_solver_v1"
    assert "requested_engine" not in result.raw
    assert "routing_reason" not in result.raw


@pytest.mark.parametrize("fallback_enabled", [True, False])
def test_local_solver_routes_supported_preflop_spot_to_chart(
    tmp_path: Path, fallback_enabled: bool
) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            postflop_solver_fallback_enabled=fallback_enabled,
        )
    )
    state = CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("2h")],
        pot_size=1.5,
        current_bet=0,
        effective_stack=100,
        players_in_hand=6,
        hero_position="button",
        street="preflop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.action == "raise"
    assert result.raw["engine"] == "preflop_chart_v1"
    assert result.raw["requested_engine"] == "postflop_solver"
    assert result.raw["routing_reason"] == "the hand is preflop"
    assert "fallback_reason" not in result.raw
    assert "routed this hand to the preflop chart" in result.explanation
    assert "range/EV fallback" not in result.explanation


def test_local_solver_keeps_ev_fallback_for_preflop_spot_without_position(tmp_path: Path) -> None:
    provider = build_provider(Settings(data_dir=tmp_path, recommendation_provider="local_solver"))
    state = CanonicalState(
        hero_cards=[Card.from_code("Ah"), Card.from_code("2h")],
        pot_size=1.5,
        current_bet=0,
        effective_stack=100,
        players_in_hand=6,
        street="preflop",
        user_approved=True,
    )

    result = provider.recommend(RecommendationRequest(state=state, provider=provider.name))

    assert result.raw["engine"] == "local_ev_solver_v1"
    assert result.raw["requested_engine"] == "postflop_solver"
    assert "range/EV fallback" in result.explanation


def test_local_solver_runs_postflop_plugin_for_supported_spot(tmp_path: Path) -> None:
    solver_script = tmp_path / "postflop.py"
    solver_script.write_text(
        "import json, os, sys\n"
        "payload = json.loads(sys.stdin.read())\n"
        "assert payload['state']['hero_position'] == 'IP'\n"
        "assert payload['state']['hero_stack'] == 97.5\n"
        "assert payload['state']['facing_action'] == 'bet'\n"
        "expected = {"
        "'POKER_POSTFLOP_SOLVER_MAX_ITERATIONS': '17', "
        "'POKER_POSTFLOP_SOLVER_TARGET_EXPLOITABILITY': '0.025', "
        "'POKER_POSTFLOP_SOLVER_MAX_MEMORY_MB': '321', "
        "'POKER_POSTFLOP_SOLVER_BET_SIZES': '50%,100%', "
        "'POKER_POSTFLOP_SOLVER_RAISE_SIZES': '3x', "
        "'POKER_POSTFLOP_SOLVER_RAKE_RATE': '0.05', "
        "'POKER_POSTFLOP_SOLVER_RAKE_CAP': '2.5', "
        "'POKER_POSTFLOP_SOLVER_OOP_RANGE': 'AA', "
        "'POKER_POSTFLOP_SOLVER_IP_RANGE': 'KK'"
        "}\n"
        "assert {key: os.environ[key] for key in expected} == expected\n"
        "print(json.dumps({"
        "'action': 'raise', "
        "'sizing': 8.5, "
        "'confidence': 0.88, "
        "'explanation': 'Postflop tree response', "
        "'raw': {'provider': 'local_solver', 'engine': 'postflop_solver'}"
        "}))\n"
    )
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            postflop_solver_command=f"{sys.executable} {solver_script}",
            postflop_solver_max_iterations=17,
            postflop_solver_target_exploitability=0.025,
            postflop_solver_max_memory_mb=321,
            postflop_solver_bet_sizes="50%,100%",
            postflop_solver_raise_sizes="3x",
            postflop_solver_rake_rate=0.05,
            postflop_solver_rake_cap=2.5,
            postflop_solver_oop_range="AA",
            postflop_solver_ip_range="KK",
        )
    )

    result = provider.recommend(
        RecommendationRequest(state=heads_up_postflop_state(), provider=provider.name)
    )

    assert result.action == "raise"
    assert result.sizing == 8.5
    assert result.raw["engine"] == "postflop_solver"
    assert "fallback_reason" not in result.raw


def test_postflop_solver_failure_uses_ev_fallback(tmp_path: Path) -> None:
    solver_script = tmp_path / "postflop.py"
    solver_script.write_text("import sys\nprint('tree too large', file=sys.stderr)\nsys.exit(8)\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            postflop_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    result = provider.recommend(
        RecommendationRequest(state=heads_up_postflop_state(), provider=provider.name)
    )

    assert result.raw["engine"] == "local_ev_solver_v1"
    assert result.raw["requested_engine"] == "postflop_solver"
    assert "tree too large" in result.raw["fallback_reason"]
    assert "range/EV fallback" in result.explanation


@pytest.mark.parametrize(
    ("solver_output", "error_message"),
    [
        ("not-json", "invalid JSON"),
        (
            '{"action":"call","sizing":2.5,"confidence":0.8,'
            '"explanation":"Malformed recommendation"}',
            "invalid payload",
        ),
    ],
)
def test_postflop_solver_malformed_response_does_not_use_ev_fallback(
    tmp_path: Path,
    solver_output: str,
    error_message: str,
) -> None:
    solver_script = tmp_path / "postflop.py"
    solver_script.write_text(f"print({solver_output!r})\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_engine="postflop_solver",
            postflop_solver_command=f"{sys.executable} {solver_script}",
            postflop_solver_fallback_enabled=True,
        )
    )

    with pytest.raises(ProviderError, match=error_message):
        provider.recommend(
            RecommendationRequest(
                state=heads_up_postflop_state(),
                provider=provider.name,
            )
        )


def test_postflop_solver_requires_position_when_fallback_is_disabled(tmp_path: Path) -> None:
    state = heads_up_postflop_state()
    state.hero_position = "SB"
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            postflop_solver_fallback_enabled=False,
        )
    )

    with pytest.raises(ProviderInputError, match="position must identify IP or OOP"):
        provider.recommend(RecommendationRequest(state=state, provider=provider.name))


def test_postflop_solver_requires_hero_stack_when_facing_bet(tmp_path: Path) -> None:
    state = heads_up_postflop_state()
    state.hero_stack = None
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            postflop_solver_fallback_enabled=False,
        )
    )

    with pytest.raises(ProviderInputError, match="hero stack is required"):
        provider.recommend(RecommendationRequest(state=state, provider=provider.name))


@pytest.mark.parametrize("facing_action", [None, "raise"])
def test_postflop_solver_rejects_unknown_or_raised_action_history(
    tmp_path: Path, facing_action: str | None
) -> None:
    state = heads_up_postflop_state()
    state.facing_action = facing_action
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            postflop_solver_fallback_enabled=False,
        )
    )

    with pytest.raises(ProviderInputError, match="raises require full action history"):
        provider.recommend(RecommendationRequest(state=state, provider=provider.name))


def test_local_solver_rejects_unknown_engine(tmp_path: Path) -> None:
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_engine="missing",
        )
    )

    with pytest.raises(ProviderConfigurationError, match="Unknown local solver engine"):
        provider.recommend(RecommendationRequest(state=approved_state(), provider=provider.name))


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


def test_local_solver_rejects_sizing_for_non_wager_action(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text(
        "print('{\"action\":\"call\",\"sizing\":2.5,\"confidence\":0.8,"
        "\"explanation\":\"Malformed recommendation\"}')\n"
    )
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(
            RecommendationRequest(state=approved_state(), provider=provider.name)
        )


def test_local_solver_rejects_nonfinite_sizing(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text(
        "print('{\"action\":\"raise\",\"sizing\":Infinity,\"confidence\":0.8,"
        "\"explanation\":\"Malformed recommendation\"}')\n"
    )
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(
            RecommendationRequest(state=approved_state(), provider=provider.name)
        )


def test_local_solver_rejects_zero_wager_sizing(tmp_path: Path) -> None:
    solver_script = tmp_path / "solver.py"
    solver_script.write_text(
        "print('{\"action\":\"raise\",\"sizing\":0,\"confidence\":0.8,"
        "\"explanation\":\"Malformed recommendation\"}')\n"
    )
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(
            RecommendationRequest(state=approved_state(), provider=provider.name)
        )


@pytest.mark.parametrize("sizing_json", ["true", '"7.5"'])
def test_local_solver_rejects_coerced_wager_sizing(
    tmp_path: Path,
    sizing_json: str,
) -> None:
    solver_script = tmp_path / "solver.py"
    payload = (
        '{"action":"raise","sizing":'
        f"{sizing_json},"
        '"confidence":0.8,"explanation":"Malformed recommendation"}'
    )
    solver_script.write_text(f"print({payload!r})\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(
            RecommendationRequest(state=approved_state(), provider=provider.name)
        )


@pytest.mark.parametrize("confidence_json", ["true", '"0.8"'])
def test_local_solver_rejects_coerced_confidence(
    tmp_path: Path,
    confidence_json: str,
) -> None:
    solver_script = tmp_path / "solver.py"
    payload = (
        '{"action":"check","sizing":null,"confidence":'
        f"{confidence_json},"
        '"explanation":"Malformed recommendation"}'
    )
    solver_script.write_text(f"print({payload!r})\n")
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="local_solver",
            local_solver_command=f"{sys.executable} {solver_script}",
        )
    )

    with pytest.raises(ProviderError, match="invalid payload"):
        provider.recommend(
            RecommendationRequest(state=approved_state(), provider=provider.name)
        )


def test_external_solver_posts_canonical_json_body(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    request = httpx.Request("POST", "https://solver.example/recommend")
    captured: dict[str, object] = {}

    def fake_post(
        url: str,
        *,
        json: dict[str, object],
        headers: dict[str, str],
        timeout: float,
    ) -> httpx.Response:
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
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
            external_provider_bearer_token="solver-token",
            external_request_timeout_seconds=9.5,
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
                "hero_stack": 97.5,
                "effective_stack": 96.0,
                "players_in_hand": 3,
                "hero_position": "button",
                "street": "flop",
                "facing_action": "bet",
                "action_context": "Cutoff bet 2.5 into 12.5",
                "user_approved": True,
            },
            "provider": "external_solver",
        },
        "headers": {"Authorization": "Bearer solver-token"},
        "timeout": 9.5,
    }


def test_llm_advice_uses_its_own_bearer_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = httpx.Request("POST", "https://llm.example/recommend")
    captured_headers: dict[str, str] = {}

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        captured_headers.update(kwargs["headers"])
        return httpx.Response(
            200,
            json={
                "action": "call",
                "sizing": None,
                "confidence": 0.7,
                "explanation": "LLM advice",
                "raw": {"provider": "llm_advice"},
            },
            request=request,
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    provider = build_provider(
        Settings(
            data_dir=tmp_path,
            recommendation_provider="llm_advice",
            llm_advice_url="https://llm.example/recommend",
            llm_advice_bearer_token="llm-token",
        )
    )

    result = provider.recommend(
        RecommendationRequest(state=approved_state(), provider=provider.name)
    )

    assert result.raw["provider"] == "llm_advice"
    assert captured_headers == {"Authorization": "Bearer llm-token"}


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
