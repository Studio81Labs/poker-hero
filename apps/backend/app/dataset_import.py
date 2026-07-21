from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
from typing import Literal, Self
from zipfile import BadZipFile, ZipFile

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, ValidationError, model_validator

from app.dataset_export import (
    DATASET_SCHEMA,
    DATASET_SCHEMA_VERSION,
    MAX_DATASET_CASES,
    dataset_case_limit_message,
)
from app.models import (
    BenchmarkDatasetImportResult,
    CanonicalState,
    DetectedState,
    JobRecord,
)
from app.storage import FileJobStore, JobNotFoundError


MAX_MANIFEST_BYTES = 1024 * 1024
SUPPORTED_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}


class DatasetImportError(RuntimeError):
    status_code = 400


class DatasetImportConflictError(DatasetImportError):
    status_code = 409


class _ManifestCase(BaseModel):
    job_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    original_filename: str = Field(min_length=1, max_length=255)
    image_file: str = Field(min_length=1, max_length=512)
    expected_state: DetectedState


class _DatasetManifest(BaseModel):
    schema_name: Literal[DATASET_SCHEMA] = Field(alias="schema")
    schema_version: Literal[DATASET_SCHEMA_VERSION]
    parser_provider: str = Field(min_length=1, max_length=100)
    layout_profile: str = Field(min_length=1, max_length=100)
    case_count: int = Field(ge=1, le=MAX_DATASET_CASES)
    cases: list[_ManifestCase] = Field(min_length=1, max_length=MAX_DATASET_CASES)

    @model_validator(mode="after")
    def validate_cases(self) -> Self:
        if self.case_count != len(self.cases):
            raise ValueError("case_count does not match cases")
        job_ids = [case.job_id for case in self.cases]
        if len(set(job_ids)) != len(job_ids):
            raise ValueError("job IDs must be unique")
        image_files = [case.image_file for case in self.cases]
        if len(set(image_files)) != len(image_files):
            raise ValueError("image paths must be unique")
        return self


@dataclass(frozen=True)
class ParsedDatasetCase:
    job_id: str
    original_filename: str
    image_bytes: bytes
    approved_state: CanonicalState


@dataclass(frozen=True)
class ParsedParserDataset:
    parser_provider: str
    layout_profile: str
    cases: tuple[ParsedDatasetCase, ...]


def parse_parser_dataset_archive(
    archive_bytes: bytes,
    max_image_bytes: int,
    max_uncompressed_bytes: int,
) -> ParsedParserDataset:
    if not archive_bytes:
        raise DatasetImportError("Dataset ZIP is empty")
    try:
        with ZipFile(BytesIO(archive_bytes)) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise DatasetImportError("Dataset ZIP contains duplicate paths")
            if any(info.flag_bits & 0x1 for info in infos):
                raise DatasetImportError("Encrypted dataset ZIPs are not supported")
            if sum(info.file_size for info in infos) > max_uncompressed_bytes:
                raise DatasetImportError("Dataset ZIP expands beyond the allowed size")
            try:
                manifest_info = archive.getinfo("manifest.json")
            except KeyError as exc:
                raise DatasetImportError("Dataset ZIP is missing manifest.json") from exc
            if manifest_info.file_size > MAX_MANIFEST_BYTES:
                raise DatasetImportError("Dataset manifest exceeds the allowed size")
            try:
                manifest = _DatasetManifest.model_validate_json(
                    archive.read(manifest_info)
                )
            except ValidationError as exc:
                first_error = exc.errors(include_url=False)[0]
                location = ".".join(str(part) for part in first_error["loc"])
                raise DatasetImportError(
                    f"Dataset manifest is invalid at {location}: {first_error['msg']}"
                ) from exc

            cases = tuple(
                _read_dataset_case(archive, case, max_image_bytes)
                for case in manifest.cases
            )
            return ParsedParserDataset(
                parser_provider=manifest.parser_provider,
                layout_profile=manifest.layout_profile,
                cases=cases,
            )
    except BadZipFile as exc:
        raise DatasetImportError("Upload must be a valid dataset ZIP") from exc


def import_parser_dataset(
    dataset: ParsedParserDataset,
    store: FileJobStore,
    recommendation_provider: str,
) -> BenchmarkDatasetImportResult:
    included_job_ids = {job.id for job in store.list() if job.benchmark_included}
    resulting_job_ids = included_job_ids | {case.job_id for case in dataset.cases}
    if len(resulting_job_ids) > MAX_DATASET_CASES:
        raise DatasetImportConflictError(
            dataset_case_limit_message(MAX_DATASET_CASES)
        )

    existing_jobs: dict[str, JobRecord] = {}
    for case in dataset.cases:
        try:
            existing = store.get(case.job_id)
        except JobNotFoundError:
            continue
        try:
            existing_image = store.image_path(existing).read_bytes()
        except (JobNotFoundError, OSError) as exc:
            raise DatasetImportConflictError(
                f"Existing job {case.job_id} does not have its source image"
            ) from exc
        if existing.approved_state != case.approved_state or existing_image != case.image_bytes:
            raise DatasetImportConflictError(
                f"Imported case {case.job_id} conflicts with an existing job"
            )
        existing_jobs[case.job_id] = existing

    imported_cases = 0
    reused_cases = 0
    for case in dataset.cases:
        existing = existing_jobs.get(case.job_id)
        if existing is not None:
            existing.benchmark_included = True
            store.save(existing)
            reused_cases += 1
            continue

        try:
            job = store.create_job(
                original_filename=case.original_filename,
                image_bytes=case.image_bytes,
                parser_provider=dataset.parser_provider,
                recommendation_provider=recommendation_provider,
                job_id=case.job_id,
            )
        except FileExistsError as exc:
            raise DatasetImportConflictError(
                f"Imported case {case.job_id} conflicts with an existing job"
            ) from exc
        job.approved_state = case.approved_state
        job.benchmark_included = True
        job.status = "approved"
        store.save(job)
        imported_cases += 1

    return BenchmarkDatasetImportResult(
        imported_cases=imported_cases,
        reused_cases=reused_cases,
        included_cases=sum(job.benchmark_included for job in store.list()),
        job_ids=[case.job_id for case in dataset.cases],
    )


def _read_dataset_case(
    archive: ZipFile,
    case: _ManifestCase,
    max_image_bytes: int,
) -> ParsedDatasetCase:
    image_path = PurePosixPath(case.image_file)
    if (
        image_path.is_absolute()
        or len(image_path.parts) != 2
        or image_path.parts[0] != "images"
        or image_path.stem != case.job_id
    ):
        raise DatasetImportError(
            f"Dataset image path is invalid for {case.original_filename}"
        )
    if "/" in case.original_filename or "\\" in case.original_filename:
        raise DatasetImportError("Dataset original filenames must not contain paths")
    try:
        image_info = archive.getinfo(case.image_file)
    except KeyError as exc:
        raise DatasetImportError(
            f"Dataset image is missing for {case.original_filename}"
        ) from exc
    if image_info.file_size > max_image_bytes:
        raise DatasetImportError(
            f"Dataset image exceeds the allowed size: {case.original_filename}"
        )
    image_bytes = archive.read(image_info)
    if not _is_supported_image(image_bytes):
        raise DatasetImportError(
            f"Dataset image is invalid: {case.original_filename}"
        )
    return ParsedDatasetCase(
        job_id=case.job_id,
        original_filename=case.original_filename,
        image_bytes=image_bytes,
        approved_state=CanonicalState(
            **case.expected_state.model_dump(),
            user_approved=True,
        ),
    )


def _is_supported_image(image_bytes: bytes) -> bool:
    if not image_bytes:
        return False
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_format = image.format
            image.verify()
            return image_format in SUPPORTED_IMAGE_FORMATS
    except (OSError, SyntaxError, UnidentifiedImageError, ValueError):
        return False
