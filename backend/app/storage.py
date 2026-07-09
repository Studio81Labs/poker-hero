from pathlib import Path

from app.models import JobRecord


class JobNotFoundError(KeyError):
    pass


class FileJobStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.jobs_dir = self.data_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)

    def create_job(
        self,
        original_filename: str,
        image_bytes: bytes,
        parser_provider: str,
        recommendation_provider: str,
    ) -> JobRecord:
        image_suffix = Path(original_filename).suffix or ".png"
        job = JobRecord(
            original_filename=original_filename,
            image_filename=f"original{image_suffix}",
            parser_provider=parser_provider,
            recommendation_provider=recommendation_provider,
        )
        job_dir = self._job_dir(job.id)
        job_dir.mkdir(parents=True, exist_ok=False)
        (job_dir / job.image_filename).write_bytes(image_bytes)
        self.save(job)
        return job

    def image_path(self, job: JobRecord) -> Path:
        return self._job_dir(job.id) / job.image_filename

    def get(self, job_id: str) -> JobRecord:
        path = self._job_path(job_id)
        if not path.exists():
            raise JobNotFoundError(job_id)
        return JobRecord.model_validate_json(path.read_text())

    def save(self, job: JobRecord) -> JobRecord:
        job.touch()
        path = self._job_path(job.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(job.model_dump_json(indent=2))
        return job

    def _job_dir(self, job_id: str) -> Path:
        return self.jobs_dir / job_id

    def _job_path(self, job_id: str) -> Path:
        return self._job_dir(job_id) / "job.json"
