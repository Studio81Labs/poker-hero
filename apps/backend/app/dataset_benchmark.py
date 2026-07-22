import argparse
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Sequence

from app.benchmarking import run_benchmark
from app.config import Settings, get_settings
from app.dataset_export import MAX_DATASET_EXPANSION_RATIO
from app.dataset_import import (
    DatasetImportError,
    import_parser_dataset,
    parse_parser_dataset_archive,
)
from app.models import BenchmarkReport
from app.parsers.base import ParserConfigurationError
from app.parsers.registry import build_parser
from app.storage import FileJobStore


class DatasetBenchmarkError(RuntimeError):
    pass


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

    if report.failed_cases:
        print(
            f"Benchmark has {report.failed_cases} failed case(s)",
            file=sys.stderr,
        )
        return 1
    if args.minimum_accuracy is not None and report.accuracy < args.minimum_accuracy:
        print(
            (
                f"Benchmark accuracy {report.accuracy:.1%} is below the minimum"
                f" {args.minimum_accuracy:.1%}"
            ),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
