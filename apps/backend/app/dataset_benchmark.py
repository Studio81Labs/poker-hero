import argparse
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Sequence, TypeVar

from app.benchmarking import run_benchmark
from app.config import Settings, get_settings
from app.dataset_export import MAX_DATASET_EXPANSION_RATIO
from app.dataset_import import (
    DatasetImportError,
    import_parser_dataset,
    parse_parser_dataset_archive,
)
from app.models import BENCHMARK_FIELDS, BenchmarkReport
from app.parsers.base import ParserConfigurationError
from app.parsers.registry import build_parser
from app.pipeline import configured_recommendation_engine
from app.storage import FileJobStore


class DatasetBenchmarkError(RuntimeError):
    pass


RequirementValue = TypeVar("RequirementValue", float, int)


def _dataset_path_from_invocation(dataset_path: Path) -> Path:
    if dataset_path.is_absolute():
        return dataset_path
    invocation_dir = os.environ.get("POKER_BENCHMARK_BASE_DIR")
    return Path(invocation_dir) / dataset_path if invocation_dir else dataset_path


def benchmark_dataset_archive(
    dataset_path: Path,
    settings: Settings,
) -> BenchmarkReport:
    try:
        archive_size = dataset_path.stat().st_size
    except OSError as exc:
        raise DatasetBenchmarkError(f"Could not read dataset ZIP: {dataset_path}") from exc
    if archive_size > settings.max_dataset_upload_bytes:
        raise DatasetBenchmarkError(
            "Dataset ZIP exceeds POKER_MAX_DATASET_UPLOAD_BYTES"
        )

    try:
        archive_bytes = dataset_path.read_bytes()
    except OSError as exc:
        raise DatasetBenchmarkError(f"Could not read dataset ZIP: {dataset_path}") from exc

    try:
        dataset = parse_parser_dataset_archive(
            archive_bytes,
            max_image_bytes=settings.max_upload_bytes,
            max_uncompressed_bytes=(
                settings.max_dataset_upload_bytes * MAX_DATASET_EXPANSION_RATIO
            ),
        )
        with TemporaryDirectory(prefix="poker-hero-benchmark-") as temp_dir:
            store = FileJobStore(Path(temp_dir))
            import_parser_dataset(
                dataset,
                store,
                recommendation_provider=settings.recommendation_provider,
                recommendation_engine=configured_recommendation_engine(settings),
                parser_provider=settings.parser_provider,
                layout_profile=settings.parser_layout_profile,
                max_archive_bytes=settings.max_dataset_upload_bytes,
            )
            parser = build_parser(settings)
            return run_benchmark(
                jobs=store.list(),
                parser=parser,
                image_path_for=store.image_path,
                parser_provider=settings.parser_provider,
                layout_profile=settings.parser_layout_profile,
            )
    except DatasetImportError as exc:
        raise DatasetBenchmarkError(f"Dataset ZIP is invalid: {exc}") from exc
    except ParserConfigurationError as exc:
        raise DatasetBenchmarkError(f"Parser configuration error: {exc}") from exc


def format_benchmark_report(report: BenchmarkReport) -> str:
    lines = [
        "Parser dataset benchmark",
        f"Parser: {report.parser_provider}",
        f"Layout: {report.layout_profile}",
        (
            f"Cases: {report.successful_cases}/{report.total_cases} completed"
            f" ({report.failed_cases} failed)"
        ),
        (
            f"Accuracy: {report.correct_fields}/{report.evaluated_fields}"
            f" ({report.accuracy:.1%})"
        ),
        "Fields:",
    ]
    lines.extend(
        f"  {metric.field}: {metric.correct}/{metric.total} ({metric.accuracy:.1%})"
        for metric in report.field_metrics
    )

    cases_needing_review = [
        case
        for case in report.cases
        if case.status == "error" or any(not item.matched for item in case.comparisons)
    ]
    if cases_needing_review:
        lines.append("Cases needing review:")
        for case in cases_needing_review:
            if case.error:
                detail = case.error
            else:
                detail = ", ".join(
                    comparison.field
                    for comparison in case.comparisons
                    if not comparison.matched
                )
            lines.append(f"  {case.original_filename}: {detail}")
    return "\n".join(lines)


def _accuracy_threshold(value: str) -> float:
    try:
        threshold = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number between 0 and 1") from exc
    if not 0 <= threshold <= 1:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return threshold


def _positive_integer(value: str) -> int:
    try:
        threshold = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if threshold <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return threshold


def _field_accuracy_threshold(value: str) -> tuple[str, float]:
    field, separator, raw_threshold = value.partition("=")
    if not separator or not field or not raw_threshold:
        raise argparse.ArgumentTypeError("must use FIELD=ACCURACY")
    if field not in BENCHMARK_FIELDS:
        raise argparse.ArgumentTypeError(f"unknown benchmark field: {field}")
    return field, _accuracy_threshold(raw_threshold)


def _field_case_threshold(value: str) -> tuple[str, int]:
    field, separator, raw_threshold = value.partition("=")
    if not separator or not field or not raw_threshold:
        raise argparse.ArgumentTypeError("must use FIELD=COUNT")
    if field not in BENCHMARK_FIELDS:
        raise argparse.ArgumentTypeError(f"unknown benchmark field: {field}")
    return field, _positive_integer(raw_threshold)


def _requirement_map(
    requirements: list[tuple[str, RequirementValue]],
    option: str,
) -> dict[str, RequirementValue]:
    result: dict[str, RequirementValue] = {}
    for field, threshold in requirements:
        if field in result:
            raise DatasetBenchmarkError(f"{option} repeats field {field}")
        result[field] = threshold
    return result


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark a Poker Hero parser against an exported dataset ZIP.",
    )
    parser.add_argument("dataset", type=Path, help="Path to an exported dataset ZIP")
    parser.add_argument(
        "--parser-provider",
        help="Override POKER_PARSER_PROVIDER for this run",
    )
    parser.add_argument(
        "--layout-profile",
        help="Override POKER_PARSER_LAYOUT_PROFILE for this run",
    )
    parser.add_argument(
        "--minimum-accuracy",
        type=_accuracy_threshold,
        help="Exit with status 1 when field accuracy is below this 0-1 threshold",
    )
    parser.add_argument(
        "--minimum-cases",
        type=_positive_integer,
        help="Fail when the corpus contains fewer cases",
    )
    parser.add_argument(
        "--minimum-field-accuracy",
        action="append",
        type=_field_accuracy_threshold,
        default=[],
        metavar="FIELD=ACCURACY",
        help="Repeat to require an accuracy ratio for a specific labeled field",
    )
    parser.add_argument(
        "--minimum-field-cases",
        action="append",
        type=_field_case_threshold,
        default=[],
        metavar="FIELD=COUNT",
        help="Repeat to require enough labeled cases for a specific field",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Write the complete benchmark report as JSON",
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    settings: Settings | None = None,
) -> int:
    args = _argument_parser().parse_args(argv)
    try:
        field_accuracy_thresholds = _requirement_map(
            args.minimum_field_accuracy,
            "--minimum-field-accuracy",
        )
        field_case_thresholds = _requirement_map(
            args.minimum_field_cases,
            "--minimum-field-cases",
        )
    except DatasetBenchmarkError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    active_settings = settings or get_settings()
    overrides: dict[str, str] = {}
    if args.parser_provider:
        overrides["parser_provider"] = args.parser_provider
    if args.layout_profile:
        overrides["parser_layout_profile"] = args.layout_profile
    if overrides:
        active_settings = active_settings.model_copy(update=overrides)

    try:
        report = benchmark_dataset_archive(
            _dataset_path_from_invocation(args.dataset),
            active_settings,
        )
    except DatasetBenchmarkError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if args.json:
        print(report.model_dump_json(indent=2))
    else:
        print(format_benchmark_report(report))

    failures = _threshold_failures(
        report,
        minimum_accuracy=args.minimum_accuracy,
        minimum_cases=args.minimum_cases,
        field_accuracy_thresholds=field_accuracy_thresholds,
        field_case_thresholds=field_case_thresholds,
    )
    for failure in failures:
        print(failure, file=sys.stderr)
    return 1 if failures else 0


def _threshold_failures(
    report: BenchmarkReport,
    *,
    minimum_accuracy: float | None,
    minimum_cases: int | None,
    field_accuracy_thresholds: dict[str, float],
    field_case_thresholds: dict[str, int],
) -> list[str]:
    failures: list[str] = []
    if report.failed_cases:
        failures.append(f"Benchmark has {report.failed_cases} failed case(s)")
    if minimum_cases is not None and report.total_cases < minimum_cases:
        failures.append(
            f"Benchmark corpus has {report.total_cases} case(s), below the minimum"
            f" {minimum_cases}"
        )
    if minimum_accuracy is not None and report.accuracy < minimum_accuracy:
        failures.append(
            f"Benchmark accuracy {report.accuracy:.1%} is below the minimum"
            f" {minimum_accuracy:.1%}"
        )

    metrics = {metric.field: metric for metric in report.field_metrics}
    for field, threshold in field_case_thresholds.items():
        total = metrics[field].total if field in metrics else 0
        if total < threshold:
            failures.append(
                f"Field {field} has {total} labeled case(s), below the minimum"
                f" {threshold}"
            )
    for field, threshold in field_accuracy_thresholds.items():
        metric = metrics.get(field)
        if metric is None:
            failures.append(f"Field {field} accuracy was not evaluated")
        elif metric.accuracy < threshold:
            failures.append(
                f"Field {field} accuracy {metric.accuracy:.1%} is below the minimum"
                f" {threshold:.1%}"
            )
    return failures


if __name__ == "__main__":
    raise SystemExit(main())
