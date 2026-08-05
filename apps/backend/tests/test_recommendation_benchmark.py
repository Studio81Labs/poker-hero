import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.models import Card, PreflopAction, RecommendationRequest, RecommendationResult
from app.providers.base import ProviderConfigurationError
from app.providers.registry import build_provider
from app.recommendation_benchmark import (
    MAX_RECOMMENDATION_BENCHMARK_BYTES,
    RECOMMENDATION_BENCHMARK_SCHEMA,
    RECOMMENDATION_BENCHMARK_SCHEMA_VERSION,
    RecommendationBenchmarkCase,
    RecommendationBenchmarkDataset,
    RecommendationBenchmarkError,
    RecommendationBenchmarkState,
    RecommendationReferenceLine,
    benchmark_recommendation_file,
    format_recommendation_benchmark_report,
    load_recommendation_benchmark_dataset,
    main,
    run_recommendation_benchmark,
)


class SequenceProvider:
    name = "test_solver"
    required_fields = ["hero_cards", "street"]

    def __init__(self, outcomes: list[RecommendationResult | Exception]) -> None:
        self.outcomes = list(outcomes)

    def required_fields_for(
        self,
        state: RecommendationBenchmarkState,
    ) -> list[str]:
        return self.required_fields

    def recommend(self, request: RecommendationRequest) -> RecommendationResult:
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def benchmark_state(**overrides: object) -> RecommendationBenchmarkState:
    values = {
        "hero_cards": [Card.from_code("Ah"), Card.from_code("Kd")],
        "board_cards": [
            Card.from_code("Qs"),
            Card.from_code("Jc"),
            Card.from_code("2h"),
        ],
        "street": "flop",
        "pot_size": 10.0,
        "current_bet": 0.0,
        "hero_stack": 100.0,
        "effective_stack": 100.0,
        "players_in_hand": 2,
        "hero_position": "button",
    }
    values.update(overrides)
    return RecommendationBenchmarkState.model_validate(values)


def reference_line(
    action: str,
    *,
    sizing: float | None = None,
    frequency: float = 1.0,
    ev_bb: float | None = None,
) -> RecommendationReferenceLine:
    return RecommendationReferenceLine.model_validate(
        {
            "action": action,
            "sizing": sizing,
            "frequency": frequency,
            "ev_bb": ev_bb,
        }
    )


def benchmark_case(
    case_id: str,
    lines: list[RecommendationReferenceLine],
    *,
    tags: list[str] | None = None,
    **state_overrides: object,
) -> RecommendationBenchmarkCase:
    return RecommendationBenchmarkCase(
        id=case_id,
        description=f"Reference case {case_id}",
        tags=tags or [],
        state=benchmark_state(**state_overrides),
        reference_lines=lines,
    )


def benchmark_dataset(
    cases: list[RecommendationBenchmarkCase],
    **overrides: object,
) -> RecommendationBenchmarkDataset:
    values = {
        "schema": RECOMMENDATION_BENCHMARK_SCHEMA,
        "schema_version": RECOMMENDATION_BENCHMARK_SCHEMA_VERSION,
        "name": "Trusted solver sample",
        "sizing_tolerance_bb": 0.01,
        "minimum_policy_frequency": 0.05,
        "cases": cases,
    }
    values.update(overrides)
    return RecommendationBenchmarkDataset.model_validate(values)


def recommendation(
    action: str,
    *,
    sizing: float | None = None,
    candidates: list[dict[str, object]] | None = None,
    fallback_reason: str | None = None,
) -> RecommendationResult:
    raw: dict[str, object] = {"engine": "reference_test_v1"}
    if candidates is not None:
        raw["candidates"] = candidates
    if fallback_reason is not None:
        raw["fallback_reason"] = fallback_reason
    return RecommendationResult.model_validate(
        {
            "action": action,
            "sizing": sizing,
            "confidence": 0.8,
            "explanation": "Test recommendation.",
            "raw": raw,
        }
    )


def write_dataset(path: Path, dataset: RecommendationBenchmarkDataset) -> Path:
    path.write_text(dataset.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
    return path


def test_recommendation_benchmark_scores_policy_ev_fallback_and_failures() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "mixed-flop",
                [
                    reference_line("check", frequency=0.4, ev_bb=0.5),
                    reference_line("bet", sizing=5.0, frequency=0.6, ev_bb=0.7),
                ],
            ),
            benchmark_case(
                "unsupported-action",
                [reference_line("fold", frequency=1.0, ev_bb=0.3)],
            ),
            benchmark_case(
                "provider-failure",
                [reference_line("check", frequency=1.0)],
            ),
        ]
    )
    provider = SequenceProvider(
        [
            recommendation(
                "check",
                candidates=[
                    {"action": "check", "sizing": None, "frequency": 0.5},
                    {"action": "bet", "sizing": 5.0, "frequency": 0.5},
                ],
            ),
            recommendation(
                "call",
                fallback_reason="raised pots are not supported",
            ),
            RuntimeError("solver unavailable"),
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.total_cases == 3
    assert report.completed_cases == 2
    assert report.failed_cases == 1
    assert report.action_correct == 1
    assert report.action_accuracy == 0.5
    assert report.line_correct == 1
    assert report.line_evaluated == 2
    assert report.line_accuracy == 0.5
    assert report.policy_evaluated_cases == 1
    assert report.average_policy_distance == 0.1
    assert report.ev_evaluated_cases == 1
    assert report.average_reference_ev_loss_bb == 0.2
    assert report.maximum_reference_ev_loss_bb == 0.2
    assert report.fallback_cases == 1
    assert report.fallback_rate == 0.5
    assert report.cases[0].engine == "reference_test_v1"
    assert report.cases[1].action_match is False
    assert report.cases[1].line_match is False
    assert report.cases[2].status == "error"
    assert report.cases[2].error == "solver unavailable"
    formatted = format_recommendation_benchmark_report(report)
    assert "Action agreement: 1/2 (50.0%)" in formatted
    assert "Average policy distance: 0.100 across 1 case(s)" in formatted
    assert "unsupported-action: mismatched action, line" in formatted
    assert "provider-failure: solver unavailable" in formatted


def test_recommendation_benchmark_runs_heads_up_limp_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-heads-up-limp-big-blind",
                [reference_line("raise", sizing=4)],
                tags=["preflop", "heads-up-limp", "big-blind-option"],
                hero_cards=[Card.from_code("Ah"), Card.from_code("Ad")],
                board_cards=[],
                street="preflop",
                pot_size=2.5,
                current_bet=0,
                hero_stack=None,
                effective_stack=100.0,
                players_in_hand=2,
                hero_position="big_blind",
                facing_action=None,
                preflop_action_history=[
                    PreflopAction(actor="button", action="call", amount=1),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_two_limper_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-two-limpers-big-blind",
                [reference_line("raise", sizing=5.25)],
                tags=["preflop", "two-limpers", "big-blind-option"],
                hero_cards=[Card.from_code("Ah"), Card.from_code("Ad")],
                board_cards=[],
                street="preflop",
                pot_size=3.5,
                current_bet=0,
                hero_stack=None,
                effective_stack=100.0,
                players_in_hand=3,
                hero_position="big_blind",
                facing_action=None,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="call", amount=1),
                    PreflopAction(actor="button", action="call", amount=1),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_three_limper_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-three-limpers-big-blind",
                [reference_line("raise", sizing=6.75)],
                tags=["preflop", "three-limpers", "big-blind-option"],
                hero_cards=[Card.from_code("Ah"), Card.from_code("Ad")],
                board_cards=[],
                street="preflop",
                pot_size=4.5,
                current_bet=0,
                hero_stack=None,
                effective_stack=100.0,
                players_in_hand=4,
                hero_position="big_blind",
                facing_action=None,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="call", amount=1),
                    PreflopAction(actor="cutoff", action="call", amount=1),
                    PreflopAction(actor="button", action="call", amount=1),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_single_caller_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-single-caller",
                [reference_line("call")],
                tags=["preflop", "single-caller"],
                hero_cards=[Card.from_code("Ah"), Card.from_code("Jh")],
                board_cards=[],
                street="preflop",
                pot_size=6.5,
                current_bet=2.5,
                hero_stack=None,
                effective_stack=100.0,
                players_in_hand=3,
                hero_position="button",
                facing_action="raise",
                preflop_opener_position="utg",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="raise", amount=2.5),
                    PreflopAction(actor="hijack", action="call", amount=2.5),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_triple_caller_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-triple-caller",
                [reference_line("raise", sizing=15)],
                tags=["preflop", "triple-caller"],
                hero_cards=[Card.from_code("Ah"), Card.from_code("Ad")],
                board_cards=[],
                street="preflop",
                pot_size=11.5,
                current_bet=2,
                hero_stack=None,
                effective_stack=100.0,
                players_in_hand=5,
                hero_position="small_blind",
                facing_action="raise",
                preflop_opener_position="utg",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="raise", amount=2.5),
                    PreflopAction(actor="hijack", action="call", amount=2.5),
                    PreflopAction(actor="cutoff", action="call", amount=2.5),
                    PreflopAction(actor="button", action="call", amount=2.5),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_four_caller_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-four-caller",
                [reference_line("raise", sizing=17.5)],
                tags=["preflop", "four-caller", "full-table"],
                hero_cards=[Card.from_code("Ah"), Card.from_code("Ad")],
                board_cards=[],
                street="preflop",
                pot_size=13.5,
                current_bet=1.5,
                hero_stack=None,
                effective_stack=100.0,
                players_in_hand=6,
                hero_position="big_blind",
                facing_action="raise",
                preflop_opener_position="utg",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="raise", amount=2.5),
                    PreflopAction(actor="hijack", action="call", amount=2.5),
                    PreflopAction(actor="cutoff", action="call", amount=2.5),
                    PreflopAction(actor="button", action="call", amount=2.5),
                    PreflopAction(actor="small_blind", action="call", amount=2.5),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_cold_three_bet_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-cold-three-bet",
                [reference_line("call")],
                tags=["preflop", "cold-three-bet"],
                hero_cards=[Card.from_code("Th"), Card.from_code("Ts")],
                board_cards=[],
                street="preflop",
                pot_size=12,
                current_bet=7,
                hero_stack=99,
                effective_stack=92,
                players_in_hand=3,
                hero_position="big_blind",
                facing_action="raise",
                preflop_opener_position="utg",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="raise", amount=2.5),
                    PreflopAction(actor="button", action="raise", amount=8),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_squeeze_response_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-facing-squeeze-after-call",
                [reference_line("call")],
                tags=["preflop", "facing-squeeze-after-call"],
                hero_cards=[Card.from_code("Th"), Card.from_code("Ts")],
                board_cards=[],
                street="preflop",
                pot_size=16,
                current_bet=7.5,
                hero_stack=97.5,
                effective_stack=90,
                players_in_hand=2,
                hero_position="button",
                facing_action="raise",
                preflop_opener_position="utg",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="raise", amount=2.5),
                    PreflopAction(actor="button", action="call", amount=2.5),
                    PreflopAction(
                        actor="small_blind",
                        action="raise",
                        amount=10,
                    ),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_four_bet_response_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-facing-four-bet",
                [reference_line("call")],
                tags=["preflop", "facing-four-bet"],
                hero_cards=[Card.from_code("Th"), Card.from_code("Ts")],
                board_cards=[],
                street="preflop",
                pot_size=29.5,
                current_bet=12,
                hero_stack=92,
                effective_stack=80,
                players_in_hand=2,
                hero_position="button",
                facing_action="raise",
                preflop_opener_position="cutoff",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="cutoff", action="raise", amount=2.5),
                    PreflopAction(actor="button", action="raise", amount=8),
                    PreflopAction(actor="cutoff", action="raise", amount=20),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_cold_four_bet_response_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-facing-cold-four-bet",
                [reference_line("call")],
                tags=["preflop", "facing-cold-four-bet"],
                hero_cards=[Card.from_code("Qh"), Card.from_code("Qd")],
                board_cards=[],
                street="preflop",
                pot_size=32,
                current_bet=12,
                hero_stack=92,
                effective_stack=80,
                players_in_hand=2,
                hero_position="cutoff",
                facing_action="raise",
                preflop_opener_position="utg",
                preflop_open_size=2.5,
                preflop_action_history=[
                    PreflopAction(actor="utg", action="raise", amount=2.5),
                    PreflopAction(actor="cutoff", action="raise", amount=8),
                    PreflopAction(actor="button", action="raise", amount=20),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_report_exposes_provenance_coverage_and_scenario_breakdowns() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "flop-cbet",
                [
                    reference_line("check", frequency=0.4, ev_bb=0.5),
                    reference_line("bet", sizing=5.0, frequency=0.6, ev_bb=0.7),
                ],
                tags=["single-raised-pot", "in-position"],
            ),
            benchmark_case(
                "turn-facing-bet",
                [
                    reference_line("fold", frequency=0.25, ev_bb=0.0),
                    reference_line("call", frequency=0.75, ev_bb=0.4),
                ],
                tags=["single-raised-pot", "facing-bet"],
                street="turn",
                board_cards=[
                    Card.from_code("Qs"),
                    Card.from_code("Jc"),
                    Card.from_code("2h"),
                    Card.from_code("4d"),
                ],
            ),
        ],
        reference_source={
            "name": "Independent Solver",
            "version": "2.1",
            "configuration": "Heads-up cash, no rake",
        },
    )
    provider = SequenceProvider(
        [
            recommendation(
                "bet",
                sizing=5.0,
                candidates=[
                    {"action": "check", "sizing": None, "frequency": 0.5},
                    {"action": "bet", "sizing": 5.0, "frequency": 0.5},
                ],
            ),
            recommendation("call"),
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.reference_source is not None
    assert report.reference_source.name == "Independent Solver"
    assert report.line_coverage == 1
    assert report.policy_coverage == 0.5
    assert report.ev_coverage == 1
    assert [item.key for item in report.street_metrics] == ["flop", "turn"]
    assert report.street_metrics[0].policy_coverage == 1
    assert report.street_metrics[1].policy_coverage == 0
    assert [item.key for item in report.tag_metrics] == [
        "facing-bet",
        "in-position",
        "single-raised-pot",
    ]
    assert report.tag_metrics[2].total_cases == 2
    formatted = format_recommendation_benchmark_report(report)
    assert "Reference: Independent Solver 2.1" in formatted
    assert "Policy evaluation coverage: 1/2 (50.0%)" in formatted
    assert "Street breakdown:" in formatted
    assert "Tag breakdown:" in formatted


def test_action_only_wager_reference_skips_line_accuracy() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "action-only",
                [reference_line("bet", frequency=1.0, ev_bb=1.0)],
            )
        ]
    )
    provider = SequenceProvider(
        [
            recommendation(
                "bet",
                sizing=7.0,
                candidates=[
                    {"action": "bet", "sizing": 7.0, "frequency": 1.0}
                ],
            )
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.action_accuracy == 1
    assert report.line_evaluated == 0
    assert report.line_accuracy is None
    assert report.policy_evaluated_cases == 1
    assert report.average_policy_distance == 0
    assert report.average_reference_ev_loss_bb == 0
    assert "Line agreement: not evaluated" in format_recommendation_benchmark_report(
        report
    )


def test_sizing_tolerance_boundary_is_not_a_line_match() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "sizing-boundary",
                [reference_line("bet", sizing=5.0)],
            )
        ]
    )

    report = run_recommendation_benchmark(
        dataset,
        SequenceProvider([recommendation("bet", sizing=5.01)]),
    )

    assert report.action_accuracy == 1
    assert report.line_accuracy == 0
    assert report.cases[0].line_match is False


def test_reference_sizes_exactly_two_tolerances_apart_are_unambiguous() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "adjacent-sizes",
                [
                    reference_line("bet", sizing=5.0, frequency=0.5),
                    reference_line("bet", sizing=5.02, frequency=0.5),
                ],
            )
        ]
    )

    assert dataset.cases[0].reference_lines[1].sizing == 5.02


def test_malformed_candidate_metadata_skips_policy_metric() -> None:
    dataset = benchmark_dataset(
        [benchmark_case("bad-candidates", [reference_line("check")])]
    )
    provider = SequenceProvider(
        [
            recommendation(
                "check",
                candidates=[
                    {"action": ["check"], "sizing": None, "frequency": 1.0}
                ],
            )
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_accuracy == 1
    assert report.policy_evaluated_cases == 0
    assert report.average_policy_distance is None


def test_zero_frequency_unsized_wager_does_not_hide_policy_metric() -> None:
    dataset = benchmark_dataset(
        [benchmark_case("deterministic-check", [reference_line("check")])]
    )
    provider = SequenceProvider(
        [
            recommendation(
                "check",
                candidates=[
                    {"action": "check", "sizing": None, "frequency": 1.0},
                    {"action": "raise", "sizing": None, "frequency": 0.0},
                ],
            )
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.policy_evaluated_cases == 1
    assert report.average_policy_distance == 0


def test_rounded_candidate_frequencies_are_normalized() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "rounded-policy",
                [
                    reference_line("check", frequency=1 / 3),
                    reference_line("bet", sizing=5.0, frequency=1 / 3),
                    reference_line("bet", sizing=7.0, frequency=1 / 3),
                ],
            )
        ]
    )
    provider = SequenceProvider(
        [
            recommendation(
                "check",
                candidates=[
                    {"action": "check", "sizing": None, "frequency": 0.3333},
                    {"action": "bet", "sizing": 5.0, "frequency": 0.3333},
                    {"action": "bet", "sizing": 7.0, "frequency": 0.3333},
                ],
            )
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.policy_evaluated_cases == 1
    assert report.average_policy_distance == 0


def test_incomplete_candidate_frequencies_hide_policy_metric() -> None:
    dataset = benchmark_dataset(
        [benchmark_case("incomplete-policy", [reference_line("check")])]
    )
    provider = SequenceProvider(
        [
            recommendation(
                "check",
                candidates=[
                    {"action": "check", "sizing": None, "frequency": 0.999}
                ],
            )
        ]
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.policy_evaluated_cases == 0
    assert report.average_policy_distance is None


def test_missing_required_state_is_an_isolated_case_failure() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "missing-cards",
                [reference_line("check")],
                hero_cards=[],
            ),
            benchmark_case("valid", [reference_line("check")]),
        ]
    )
    provider = SequenceProvider([recommendation("check")])

    report = run_recommendation_benchmark(dataset, provider)

    assert report.failed_cases == 1
    assert report.completed_cases == 1
    assert report.cases[0].error == "Missing required fields: hero_cards"
    assert report.cases[1].action_match is True


def test_missing_street_is_visible_in_unknown_breakdown() -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "missing-street",
                [reference_line("check")],
                street=None,
            )
        ]
    )

    report = run_recommendation_benchmark(dataset, SequenceProvider([]))

    assert report.failed_cases == 1
    assert [item.key for item in report.street_metrics] == ["unknown"]
    assert report.street_metrics[0].failed_cases == 1


@pytest.mark.parametrize(
    "mutation",
    [
        "coerced_version",
        "duplicate_case",
        "frequency_total",
        "partial_ev",
        "ambiguous_sizing",
        "duplicate_tag",
        "invalid_tag",
        "extra_reference_source_field",
        "extra_state_field",
    ],
)
def test_recommendation_benchmark_dataset_rejects_invalid_schema(
    mutation: str,
) -> None:
    payload = {
        "schema": RECOMMENDATION_BENCHMARK_SCHEMA,
        "schema_version": RECOMMENDATION_BENCHMARK_SCHEMA_VERSION,
        "name": "Invalid sample",
        "sizing_tolerance_bb": 0.01,
        "minimum_policy_frequency": 0.05,
        "cases": [
            {
                "id": "case-1",
                "state": benchmark_state().model_dump(mode="json"),
                "reference_lines": [
                    {
                        "action": "check",
                        "sizing": None,
                        "frequency": 1.0,
                        "ev_bb": None,
                    }
                ],
            }
        ],
    }
    if mutation == "coerced_version":
        payload["schema_version"] = True
    elif mutation == "duplicate_case":
        payload["cases"].append(payload["cases"][0])
    elif mutation == "frequency_total":
        payload["cases"][0]["reference_lines"][0]["frequency"] = 0.9
    elif mutation == "partial_ev":
        payload["cases"][0]["reference_lines"] = [
            {"action": "check", "frequency": 0.5, "ev_bb": 0.1},
            {"action": "bet", "sizing": 5.0, "frequency": 0.5},
        ]
    elif mutation == "ambiguous_sizing":
        payload["cases"][0]["reference_lines"] = [
            {"action": "bet", "sizing": 5.0, "frequency": 0.5},
            {"action": "bet", "sizing": 5.01, "frequency": 0.5},
        ]
    elif mutation == "duplicate_tag":
        payload["cases"][0]["tags"] = ["facing-bet", "facing-bet"]
    elif mutation == "invalid_tag":
        payload["cases"][0]["tags"] = ["Facing bet"]
    elif mutation == "extra_reference_source_field":
        payload["reference_source"] = {
            "name": "Independent Solver",
            "license_key": "not-allowed",
        }
    else:
        payload["cases"][0]["state"]["invented"] = "value"

    with pytest.raises(ValidationError):
        RecommendationBenchmarkDataset.model_validate(payload)


def test_benchmark_file_rejects_invalid_and_oversized_json(tmp_path: Path) -> None:
    invalid_path = tmp_path / "invalid.json"
    invalid_path.write_text("not json", encoding="utf-8")

    with pytest.raises(RecommendationBenchmarkError, match="invalid"):
        load_recommendation_benchmark_dataset(invalid_path)

    oversized_path = tmp_path / "oversized.json"
    oversized_path.write_bytes(b"x" * (MAX_RECOMMENDATION_BENCHMARK_BYTES + 1))
    with pytest.raises(RecommendationBenchmarkError, match="4 MiB"):
        load_recommendation_benchmark_dataset(oversized_path)


def test_loader_accepts_legacy_version_one_corpus(tmp_path: Path) -> None:
    payload = benchmark_dataset(
        [benchmark_case("legacy-check", [reference_line("check")])]
    ).model_dump(mode="json", by_alias=True)
    payload["schema_version"] = 1
    payload.pop("reference_source")
    payload["cases"][0].pop("tags")
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    dataset = load_recommendation_benchmark_dataset(path)

    assert dataset.schema_version == 1
    assert dataset.reference_source is None
    assert dataset.cases[0].tags == []


def test_recommendation_benchmark_cli_emits_json_and_enforces_thresholds(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [
                benchmark_case(
                    "mixed-flop",
                    [
                        reference_line("check", frequency=0.4, ev_bb=0.5),
                        reference_line(
                            "bet",
                            sizing=5.0,
                            frequency=0.6,
                            ev_bb=0.7,
                        ),
                    ],
                )
            ]
        ),
    )
    provider = SequenceProvider(
        [
            recommendation(
                "check",
                candidates=[
                    {"action": "check", "sizing": None, "frequency": 0.5},
                    {"action": "bet", "sizing": 5.0, "frequency": 0.5},
                ],
            )
        ]
    )

    exit_code = main(
        [
            str(dataset_path),
            "--json",
            "--minimum-action-accuracy",
            "1",
            "--minimum-line-accuracy",
            "1",
            "--maximum-policy-distance",
            "0.05",
            "--maximum-ev-loss",
            "0.1",
            "--maximum-fallback-rate",
            "0",
        ],
        settings=Settings(data_dir=tmp_path / "unused"),
        provider=provider,
    )

    captured = capsys.readouterr()
    report = json.loads(captured.out)
    assert exit_code == 1
    assert report["provider"] == "test_solver"
    assert report["action_accuracy"] == 1
    assert "Average policy distance 0.100 is above the maximum 0.050" in captured.err
    assert "Average reference EV loss 0.200 BB is above the maximum 0.100 BB" in (
        captured.err
    )


def test_recommendation_benchmark_cli_resolves_relative_path(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invocation_dir = tmp_path / "repository-root"
    invocation_dir.mkdir()
    write_dataset(
        invocation_dir / "recommendations.json",
        benchmark_dataset(
            [benchmark_case("check", [reference_line("check")])]
        ),
    )
    monkeypatch.setenv("POKER_BENCHMARK_BASE_DIR", str(invocation_dir))

    exit_code = main(
        ["recommendations.json"],
        settings=Settings(data_dir=tmp_path / "unused"),
        provider=SequenceProvider([recommendation("check")]),
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "Action agreement: 1/1 (100.0%)" in captured.out
    assert captured.err == ""


def test_cli_enforces_reference_source_and_evaluation_coverage(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [
                benchmark_case(
                    "action-only",
                    [reference_line("bet")],
                )
            ]
        ),
    )

    exit_code = main(
        [
            str(dataset_path),
            "--require-reference-source",
            "--minimum-line-coverage",
            "1",
            "--minimum-policy-coverage",
            "1",
            "--minimum-ev-coverage",
            "1",
        ],
        settings=Settings(data_dir=tmp_path / "unused"),
        provider=SequenceProvider([recommendation("bet", sizing=5.0)]),
    )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "Benchmark reference source is not recorded" in captured.err
    assert "Line evaluation coverage 0.0% is below the minimum 100.0%" in (
        captured.err
    )
    assert "Policy evaluation coverage 0.0% is below the minimum 100.0%" in (
        captured.err
    )
    assert "EV evaluation coverage 0.0% is below the minimum 100.0%" in captured.err


def test_cli_fails_when_a_required_optional_metric_is_unavailable(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [
                benchmark_case(
                    "action-only",
                    [reference_line("bet")],
                )
            ]
        ),
    )

    exit_code = main(
        [str(dataset_path), "--minimum-line-accuracy", "0"],
        settings=Settings(data_dir=tmp_path / "unused"),
        provider=SequenceProvider([recommendation("bet", sizing=5.0)]),
    )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "Line accuracy was not evaluated" in captured.err


def test_cli_reports_unknown_provider_as_configuration_error(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [benchmark_case("check", [reference_line("check")])]
        ),
    )

    exit_code = main(
        [str(dataset_path), "--provider", "unknown"],
        settings=Settings(data_dir=tmp_path / "unused"),
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "Unknown recommendation provider: unknown" in captured.err


def test_cli_reports_deferred_provider_configuration_error(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [benchmark_case("check", [reference_line("check")])]
        ),
    )
    provider = SequenceProvider(
        [ProviderConfigurationError("provider URL is required")]
    )

    exit_code = main(
        [str(dataset_path)],
        settings=Settings(data_dir=tmp_path / "unused"),
        provider=provider,
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "provider URL is required" in captured.err


def test_cli_reports_environment_settings_validation_error(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [benchmark_case("check", [reference_line("check")])]
        ),
    )
    raw_value = "not-a-number-sensitive-sentinel"
    monkeypatch.setenv("POKER_EXTERNAL_REQUEST_TIMEOUT_SECONDS", raw_value)
    get_settings.cache_clear()

    try:
        exit_code = main([str(dataset_path)])
    finally:
        get_settings.cache_clear()

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "Settings configuration is invalid" in captured.err
    assert "external_request_timeout_seconds" in captured.err
    assert raw_value not in captured.err


def test_benchmark_file_uses_configured_provider(tmp_path: Path) -> None:
    path = write_dataset(
        tmp_path / "recommendations.json",
        benchmark_dataset(
            [benchmark_case("check", [reference_line("check")])]
        ),
    )

    report = benchmark_recommendation_file(
        path,
        Settings(
            data_dir=tmp_path / "unused",
            recommendation_provider="mock",
        ),
    )

    assert report.provider == "mock"
    assert report.total_cases == 1


def test_recommendation_benchmark_runs_isolation_response_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-facing-isolation-raise-after-limp",
                [reference_line("call")],
                tags=["preflop", "isolation-raise", "hero-limp"],
                hero_cards=[Card.from_code("9h"), Card.from_code("9s")],
                board_cards=[],
                street="preflop",
                pot_size=6.5,
                current_bet=3,
                hero_stack=99,
                effective_stack=90,
                players_in_hand=2,
                hero_position="utg",
                facing_action="raise",
                preflop_action_history=[
                    PreflopAction(actor="utg", action="call", amount=1),
                    PreflopAction(actor="button", action="raise", amount=4),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"


def test_recommendation_benchmark_runs_limp_reraise_preflop_chart(
    tmp_path: Path,
) -> None:
    dataset = benchmark_dataset(
        [
            benchmark_case(
                "preflop-facing-limp-reraise",
                [reference_line("call")],
                tags=["preflop", "limp-reraise", "hero-isolation"],
                hero_cards=[Card.from_code("Th"), Card.from_code("Ts")],
                board_cards=[],
                street="preflop",
                pot_size=17.5,
                current_bet=8,
                hero_stack=96,
                effective_stack=88,
                players_in_hand=2,
                hero_position="button",
                facing_action="raise",
                preflop_action_history=[
                    PreflopAction(actor="utg", action="call", amount=1),
                    PreflopAction(actor="button", action="raise", amount=4),
                    PreflopAction(actor="utg", action="raise", amount=12),
                ],
            )
        ]
    )
    provider = build_provider(
        Settings(data_dir=tmp_path, recommendation_provider="local_solver")
    )

    report = run_recommendation_benchmark(dataset, provider)

    assert report.completed_cases == 1
    assert report.action_correct == 1
    assert report.line_correct == 1
    assert report.fallback_cases == 0
    assert report.cases[0].engine == "preflop_chart_v1"
