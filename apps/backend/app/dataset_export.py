import json
from collections.abc import Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from tempfile import SpooledTemporaryFile
from typing import BinaryIO
from zipfile import ZIP_DEFLATED, ZipFile

from app.models import JobRecord


DATASET_SCHEMA = "poker-hero-parser-dataset"
DATASET_SCHEMA_VERSION = 1
ARCHIVE_MEMORY_LIMIT = 8 * 1024 * 1024
STREAM_CHUNK_SIZE = 1024 * 1024


class DatasetExportError(RuntimeError):
    pass


def build_parser_dataset_archive(
    jobs: list[JobRecord],
    image_path_for: Callable[[JobRecord], Path],
    parser_provider: str,
    layout_profile: str,
) -> BinaryIO:
    archive_file = SpooledTemporaryFile(max_size=ARCHIVE_MEMORY_LIMIT, mode="w+b")
    cases: list[dict[str, object]] = []
    try:
        with ZipFile(archive_file, mode="w", compression=ZIP_DEFLATED) as archive:
            for job in sorted(jobs, key=lambda candidate: (candidate.created_at, candidate.id)):
                if job.approved_state is None or not job.approved_state.user_approved:
                    raise DatasetExportError(
                        f"{job.original_filename} does not have approved ground truth"
                    )
                try:
                    image_path = image_path_for(job)
                except (KeyError, OSError, ValueError) as exc:
                    raise DatasetExportError(
                        f"Image is unavailable for {job.original_filename}"
                    ) from exc
                if not image_path.is_file():
                    raise DatasetExportError(
                        f"Image is unavailable for {job.original_filename}"
                    )

                image_name = f"images/{job.id}{image_path.suffix.lower() or '.png'}"
                archive.write(image_path, arcname=image_name)
                cases.append(
                    {
                        "job_id": job.id,
                        "original_filename": job.original_filename,
                        "image_file": image_name,
                        "expected_state": job.approved_state.model_dump(
                            mode="json",
                            exclude={"user_approved"},
                        ),
                    }
                )

            manifest = {
                "schema": DATASET_SCHEMA,
                "schema_version": DATASET_SCHEMA_VERSION,
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "parser_provider": parser_provider,
                "layout_profile": layout_profile,
                "case_count": len(cases),
                "cases": cases,
            }
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, indent=2, ensure_ascii=True) + "\n",
            )
        archive_file.seek(0)
        return archive_file
    except Exception:
        archive_file.close()
        raise


def stream_archive(archive_file: BinaryIO) -> Iterator[bytes]:
    try:
        while chunk := archive_file.read(STREAM_CHUNK_SIZE):
            yield chunk
    finally:
        archive_file.close()
