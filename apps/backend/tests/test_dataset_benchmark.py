import base64
import json
from pathlib import Path

import pytest

from app.config import Settings
from app.dataset_benchmark import (
    DatasetBenchmarkError,
    benchmark_dataset_archive,
    format_benchmark_report,
    main,
)
from app.dataset_export import (
    ParserDatasetArchiveCase,
    build_parser_dataset_archive_from_cases,
)
from app.models import CanonicalState, Card


VALID_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="
)


def expected_mock_state(**overrides: object) -> CanonicalState:
    values = {
        "hero_cards": [Card.from_code("Ah"), Card.from_code("Kd")],
        "board_cards": [
            Card.from_code("Qs"),
            Card.from_code("Jc"),
            Card.from_code("2h"),
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
    }
    values.update(overrides)
    return CanonicalState.model_validate(values)


def write_dataset_archive(
    path: Path,
    expected_state: CanonicalState,
) -> Path:
    archive = build_parser_dataset_archive_from_cases(
        [
            ParserDatasetArchiveCase(
                job_id="a" * 32,
                original_filename="table.png",
                image_suffix=".png",
                image_source=VALID_PNG,
                expected_state=expected_state,
            )
        ],
        parser_provider="ocr_cv",
        layout_profile="fortuna_nations",
        max_archive_bytes=1024 * 1024,
    )
    try:
        path.write_bytes(archive.read())
    finally:
        archive.close()
    return path


def test_benchmark_dataset_archive_scores_without_mutating_configured_data(
    tmp_path: Path,
) -> None:
    dataset_path = write_dataset_archive(
        tmp_path / "dataset.zip",
        expected_mock_state(),
    )
    data_dir = tmp_path / "production-data"
    settings = Settings(
        data_dir=data_dir,
        parser_provider="mock",
        parser_layout_profile="generic",
    )

    report = benchmark_dataset_archive(dataset_path, settings)

    assert report.parser_provider == "mock"
    assert report.layout_profile == "generic"
    assert report.total_cases == 1
    assert report.failed_cases == 0
    assert report.accuracy == 1
    assert not data_dir.exists()
    assert dataset_path.exists()
    assert "Accuracy: 11/11 (100.0%)" in format_benchmark_report(report)


def test_benchmark_cli_emits_json_and_fails_below_threshold(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    dataset_path = write_dataset_archive(
        tmp_path / "dataset.zip",
        expected_mock_state(pot_size=99),
    )
    settings = Settings(data_dir=tmp_path / "unused", parser_provider="ocr_cv")

    exit_code = main(
        [
            str(dataset_path),
            "--parser-provider",
            "mock",
            "--layout-profile",
            "generic",
            "--minimum-accuracy",
            "1",
            "--json",
        ],
        settings=settings,
    )

    captured = capsys.readouterr()
    report = json.loads(captured.out)
    assert exit_code == 1
    assert report["parser_provider"] == "mock"
    assert report["accuracy"] == pytest.approx(10 / 11)
    assert "below the minimum 100.0%" in captured.err


def test_benchmark_dataset_archive_rejects_invalid_and_oversized_files(
    tmp_path: Path,
) -> None:
    invalid_path = tmp_path / "invalid.zip"
    invalid_path.write_bytes(b"not a zip")
    settings = Settings(data_dir=tmp_path / "unused")

    with pytest.raises(DatasetBenchmarkError, match="valid dataset ZIP"):
        benchmark_dataset_archive(invalid_path, settings)

    with pytest.raises(
        DatasetBenchmarkError,
        match="POKER_MAX_DATASET_UPLOAD_BYTES",
    ):
        benchmark_dataset_archive(
            invalid_path,
            Settings(
                data_dir=tmp_path / "unused",
                max_dataset_upload_bytes=4,
            ),
        )
