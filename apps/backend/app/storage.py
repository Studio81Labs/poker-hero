import os
import re
import tempfile
from pathlib import Path

from app.models import BenchmarkDatasetImportResult, BenchmarkReport, JobRecord

JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
BENCHMARK_ID_PATTERN = JOB_ID_PATTERN
BENCHMARK_IMPORT_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class JobNotFoundError(KeyError):
    pass


class BenchmarkNotFoundError(KeyError):
    pass


class BenchmarkImportNotFoundError(KeyError):
    pass


class FileJobStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.jobs_dir = (self.data_dir / "jobs").resolve()
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def create_job(
        self,
        original_filename: str,
        image_bytes: bytes,
        parser_provider: str,
        recommendation_provider: str,
        job_id: str | None = None,
        upload_request_id: str | None = None,
    ) -> JobRecord:
        image_suffix = Path(original_filename).suffix or ".png"
        job_values = {
            "original_filename": original_filename,
            "image_filename": f"original{image_suffix}",
            "parser_provider": parser_provider,
            "recommendation_provider": recommendation_provider,
            "upload_request_id": upload_request_id,
        }
        if job_id is not None:
            job_values["id"] = job_id
        job = JobRecord.model_validate(job_values)
        job_dir = self._job_dir(job.id)
        job_dir.mkdir(parents=True, exist_ok=False)
        self.image_path(job).write_bytes(image_bytes)
        self.save(job)
        return job

    def image_path(self, job: JobRecord) -> Path:
        job_dir = self._job_dir(job.id)
        return self._resolve_under(job_dir, job_dir / job.image_filename)

    def get(self, job_id: str) -> JobRecord:
        path = self._job_path(job_id)
        if not path.exists():
            raise JobNotFoundError(job_id)
        return JobRecord.model_validate_json(path.read_text())

    def list(self) -> list[JobRecord]:
        jobs = [
            JobRecord.model_validate_json(path.read_text())
            for path in self.jobs_dir.glob("*/job.json")
        ]
        return sorted(jobs, key=lambda job: job.created_at)

    def save(self, job: JobRecord) -> JobRecord:
        job.touch()
        path = self._job_path(job.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                dir=path.parent,
                encoding="utf-8",
                prefix="job.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(job.model_dump_json(indent=2))
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_path, path)
        finally:
            if temp_path is not None and temp_path.exists():
                temp_path.unlink()
        return job

    def _job_dir(self, job_id: str) -> Path:
        self._validate_job_id(job_id)
        return self._resolve_under(self.jobs_dir, self.jobs_dir / job_id)

    def _job_path(self, job_id: str) -> Path:
        return self._resolve_under(self.jobs_dir, self._job_dir(job_id) / "job.json")

    def _validate_job_id(self, job_id: str) -> None:
        if JOB_ID_PATTERN.fullmatch(job_id) is None:
            raise JobNotFoundError(job_id)

    def _resolve_under(self, base_dir: Path, candidate: Path) -> Path:
        base = base_dir.resolve()
        path = candidate.resolve(strict=False)
        try:
            path.relative_to(base)
        except ValueError as exc:
            raise JobNotFoundError(str(candidate)) from exc
        return path


class FileBenchmarkStore:
    def __init__(self, data_dir: Path) -> None:
        self.benchmarks_dir = (data_dir / "benchmarks").resolve()
        self.benchmarks_dir.mkdir(parents=True, exist_ok=True)
        self.imports_dir = (self.benchmarks_dir / "imports").resolve()
        self.imports_dir.mkdir(parents=True, exist_ok=True)

    def get_latest(self) -> BenchmarkReport | None:
        path = self.benchmarks_dir / "latest.json"
        if not path.exists():
            return None
        return BenchmarkReport.model_validate_json(path.read_text())

    def get(self, report_id: str) -> BenchmarkReport:
        path = self._report_path(report_id)
        if not path.exists():
            raise BenchmarkNotFoundError(report_id)
        return BenchmarkReport.model_validate_json(path.read_text())

    def list(self, limit: int = 10) -> list[BenchmarkReport]:
        if limit <= 0:
            return []

        report_paths = sorted(
            (
                path
                for path in self.benchmarks_dir.glob("*.json")
                if BENCHMARK_ID_PATTERN.fullmatch(path.stem) is not None
            ),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )[:limit]
        reports = [
            BenchmarkReport.model_validate_json(path.read_text())
            for path in report_paths
        ]
        return sorted(reports, key=lambda report: report.created_at, reverse=True)

    def save(self, report: BenchmarkReport) -> BenchmarkReport:
        payload = report.model_dump_json(indent=2)
        self._atomic_write(self.benchmarks_dir / f"{report.id}.json", payload)
        self._atomic_write(self.benchmarks_dir / "latest.json", payload)
        return report

    def get_import(self, request_id: str) -> BenchmarkDatasetImportResult:
        path = self._import_path(request_id)
        if not path.exists():
            raise BenchmarkImportNotFoundError(request_id)
        return BenchmarkDatasetImportResult.model_validate_json(path.read_text())

    def save_import(
        self,
        request_id: str,
        result: BenchmarkDatasetImportResult,
    ) -> BenchmarkDatasetImportResult:
        self._atomic_write(
            self._import_path(request_id),
            result.model_dump_json(indent=2),
        )
        return result

    def _report_path(self, report_id: str) -> Path:
        if BENCHMARK_ID_PATTERN.fullmatch(report_id) is None:
            raise BenchmarkNotFoundError(report_id)
        return self.benchmarks_dir / f"{report_id}.json"

    def _import_path(self, request_id: str) -> Path:
        if BENCHMARK_IMPORT_REQUEST_ID_PATTERN.fullmatch(request_id) is None:
            raise BenchmarkImportNotFoundError(request_id)
        return self.imports_dir / f"{request_id}.json"

    def _atomic_write(self, path: Path, payload: str) -> None:
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                dir=path.parent,
                encoding="utf-8",
                prefix="benchmark.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(payload)
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_path, path)
        finally:
            if temp_path is not None and temp_path.exists():
                temp_path.unlink()
