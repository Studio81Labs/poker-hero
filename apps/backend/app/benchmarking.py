import math
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.models import (
    BenchmarkCaseResult,
    BenchmarkFieldComparison,
    BenchmarkFieldMetric,
    BenchmarkReport,
    CanonicalState,
    DetectedState,
    JobRecord,
)
from app.parsers.base import ParserConfigurationError, ScreenshotParser


BENCHMARK_FIELDS = (
    "hero_cards",
    "board_cards",
    "street",
    "pot_size",
    "current_bet",
    "hero_stack",
    "effective_stack",
    "players_in_hand",
    "hero_position",
    "preflop_opener_position",
    "preflop_open_size",
    "facing_action",
    "action_context",
)

POSITION_ALIASES = {
    "btn": "button",
    "dealer": "button",
    "ip": "in position",
    "oop": "out of position",
}


def run_benchmark(
    jobs: list[JobRecord],
    parser: ScreenshotParser,
    image_path_for: Callable[[JobRecord], Path],
    parser_provider: str,
    layout_profile: str,
) -> BenchmarkReport:
    cases = [
        _run_case(job, parser, image_path_for)
        for job in jobs
        if job.benchmark_included and job.approved_state is not None
    ]
    field_totals = {field: [0, 0] for field in BENCHMARK_FIELDS}
    for case in cases:
        for comparison in case.comparisons:
            field_totals[comparison.field][1] += 1
            if comparison.matched:
                field_totals[comparison.field][0] += 1

    field_metrics = [
        BenchmarkFieldMetric(
            field=field,
            correct=counts[0],
            total=counts[1],
            accuracy=counts[0] / counts[1],
        )
        for field, counts in field_totals.items()
        if counts[1] > 0
    ]
    correct_fields = sum(case.correct_fields for case in cases)
    evaluated_fields = sum(case.evaluated_fields for case in cases)
    failed_cases = sum(case.status == "error" for case in cases)
    return BenchmarkReport(
        parser_provider=parser_provider,
        layout_profile=layout_profile,
        total_cases=len(cases),
        successful_cases=len(cases) - failed_cases,
        failed_cases=failed_cases,
        correct_fields=correct_fields,
        evaluated_fields=evaluated_fields,
        accuracy=correct_fields / evaluated_fields if evaluated_fields else 0,
        field_metrics=field_metrics,
        cases=cases,
    )


def _run_case(
    job: JobRecord,
    parser: ScreenshotParser,
    image_path_for: Callable[[JobRecord], Path],
) -> BenchmarkCaseResult:
    expected = job.approved_state
    if expected is None:
        raise ValueError("Benchmark case requires an approved state")

    try:
        image_path = image_path_for(job)
        result = parser.parse(image_path)
    except ParserConfigurationError:
        raise
    except Exception as exc:
        comparisons = _compare_states(expected, None, {})
        return BenchmarkCaseResult(
            job_id=job.id,
            original_filename=job.original_filename,
            status="error",
            correct_fields=0,
            evaluated_fields=len(comparisons),
            accuracy=0,
            error=str(exc),
            comparisons=comparisons,
        )

    comparisons = _compare_states(expected, result.state, result.confidences)
    correct = sum(comparison.matched for comparison in comparisons)
    return BenchmarkCaseResult(
        job_id=job.id,
        original_filename=job.original_filename,
        status="completed",
        correct_fields=correct,
        evaluated_fields=len(comparisons),
        accuracy=correct / len(comparisons) if comparisons else 0,
        warnings=result.warnings,
        comparisons=comparisons,
    )


def _compare_states(
    expected: CanonicalState,
    detected: DetectedState | None,
    confidences: dict[str, float],
) -> list[BenchmarkFieldComparison]:
    comparisons: list[BenchmarkFieldComparison] = []
    for field in BENCHMARK_FIELDS:
        expected_value = getattr(expected, field)
        if not _is_labeled(field, expected_value, expected.street):
            continue
        detected_value = getattr(detected, field) if detected is not None else None
        normalized_expected = _normalize(field, expected_value)
        normalized_detected = _normalize(field, detected_value)
        comparisons.append(
            BenchmarkFieldComparison(
                field=field,
                expected=normalized_expected,
                detected=normalized_detected,
                matched=_matches(normalized_expected, normalized_detected),
                confidence=confidences.get(field),
            )
        )
    return comparisons


def _is_labeled(field: str, value: Any, street: str | None) -> bool:
    if value is None:
        return False
    if field == "hero_cards":
        return bool(value)
    if field == "board_cards":
        return bool(value) or street == "preflop"
    if field == "action_context":
        return bool(str(value).strip())
    return True


def _normalize(field: str, value: Any) -> Any:
    if value is None:
        return None
    if field in {"hero_cards", "board_cards"}:
        codes = [card.code for card in value]
        return sorted(codes)
    if isinstance(value, str):
        normalized = re.sub(r"\s+", " ", value.strip().lower())
        if field in {"hero_position", "preflop_opener_position"}:
            return POSITION_ALIASES.get(normalized, normalized)
        return normalized
    return value


def _matches(expected: Any, detected: Any) -> bool:
    if isinstance(expected, (int, float)) and isinstance(detected, (int, float)):
        return math.isclose(float(expected), float(detected), abs_tol=0.01)
    return expected == detected
