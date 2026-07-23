from contextlib import ExitStack
from datetime import datetime, timezone
from io import BytesIO
from threading import Lock

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, UnidentifiedImageError

from app.config import Settings, get_settings
from app.benchmarking import run_benchmark
from app.dataset_export import (
    DatasetExportError,
    MAX_DATASET_CASES,
    MAX_DATASET_EXPANSION_RATIO,
    build_parser_dataset_archive,
    dataset_case_limit_message,
    stream_archive,
)
from app.dataset_import import (
    DatasetImportError,
    import_parser_dataset,
    parse_parser_dataset_archive,
)
from app.models import (
    BenchmarkDatasetImportResult,
    BenchmarkOverview,
    BenchmarkReport,
    BenchmarkReportSummary,
    BenchmarkSelectionRequest,
    CanonicalState,
    JobRecord,
    RecommendationRequest,
    TrainingDecision,
    TrainingDecisionRequest,
    TrainingProgress,
    TrainingReviewOrder,
)
from app.parsers.base import ParserConfigurationError, ParserError
from app.parsers.registry import build_parser
from app.providers.base import (
    ProviderConfigurationError,
    ProviderError,
    ProviderInputError,
    missing_required_fields,
)
from app.providers.registry import build_provider
from app.storage import (
    BenchmarkNotFoundError,
    FileBenchmarkStore,
    FileJobStore,
    JobNotFoundError,
)
from app.training import summarize_training, training_outcome

SUPPORTED_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}
JOB_LOCK_STRIPES = 64


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or get_settings()
    store = FileJobStore(active_settings.data_dir)
    benchmark_store = FileBenchmarkStore(active_settings.data_dir)
    # Fixed stripes serialize each job without retaining caller-supplied IDs.
    job_locks = tuple(Lock() for _ in range(JOB_LOCK_STRIPES))
    dataset_import_lock = Lock()
    benchmark_corpus_lock = Lock()

    def job_lock_index(job_id: str) -> int:
        return hash(job_id) % len(job_locks)

    def job_lock_for(job_id: str):
        return job_locks[job_lock_index(job_id)]

    def current_recommendation_target(
        job_id: str,
        expected_state: CanonicalState,
    ) -> JobRecord:
        current = load_job_or_404(store, job_id)
        if current.approved_state != expected_state:
            raise HTTPException(
                status_code=409,
                detail="Approved state changed while the recommendation was running",
            )
        return current

    app = FastAPI(title="Poker Training Analyzer API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=active_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {
            "status": "ok",
            "parser_provider": active_settings.parser_provider,
            "recommendation_provider": active_settings.recommendation_provider,
            "recommendation_engine": (
                (
                    "custom_local"
                    if active_settings.local_solver_command
                    and active_settings.local_solver_command.strip()
                    else active_settings.local_solver_engine
                )
                if active_settings.recommendation_provider == "local_solver"
                else active_settings.recommendation_provider
            ),
        }

    @app.post("/api/jobs", response_model=JobRecord, status_code=status.HTTP_201_CREATED)
    async def create_job(file: UploadFile = File(...)) -> JobRecord:
        image_bytes = await file.read(active_settings.max_upload_bytes + 1)
        if len(image_bytes) > active_settings.max_upload_bytes:
            raise HTTPException(status_code=413, detail="Upload exceeds maximum size")
        if not is_supported_image(image_bytes):
            raise HTTPException(status_code=400, detail="Upload must contain supported image data")

        job = store.create_job(
            original_filename=file.filename or "screenshot.png",
            image_bytes=image_bytes,
            parser_provider=active_settings.parser_provider,
            recommendation_provider=active_settings.recommendation_provider,
        )
        try:
            parser = build_parser(active_settings)
            parser_result = parser.parse(store.image_path(job))
        except ParserConfigurationError as exc:
            job.status = "error"
            job.error = str(exc)
            store.save(job)
            raise HTTPException(status_code=500, detail=f"Parser configuration error: {exc}") from exc
        except ParserError as exc:
            job.status = "error"
            job.error = str(exc)
            store.save(job)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        job.parser_result = parser_result
        job.status = "parsed"
        if should_auto_approve(parser_result.confidences, active_settings):
            job.approved_state = CanonicalState.from_parser_result(parser_result)
            job.approved_state.user_approved = True
            job.status = "approved"
        return store.save(job)

    @app.get("/api/jobs/{job_id}", response_model=JobRecord)
    def get_job(job_id: str) -> JobRecord:
        return load_job_or_404(store, job_id)

    @app.get("/api/jobs/{job_id}/image")
    def get_job_image(job_id: str) -> FileResponse:
        job = load_job_or_404(store, job_id)
        try:
            image_path = store.image_path(job)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc
        if not image_path.is_file():
            raise HTTPException(status_code=404, detail="Job image not found")
        return FileResponse(image_path)

    @app.post("/api/jobs/{job_id}/approve", response_model=JobRecord)
    def approve_job(job_id: str, state: CanonicalState) -> JobRecord:
        with job_lock_for(job_id):
            job = load_job_or_404(store, job_id)
            state.user_approved = True
            job.approved_state = state
            job.training_decision = None
            job.recommendation = None
            job.training_reviewed_at = None
            job.status = "approved"
            job.error = None
            return store.save(job)

    @app.put("/api/jobs/{job_id}/decision", response_model=JobRecord)
    def record_training_decision(
        job_id: str,
        decision: TrainingDecisionRequest,
    ) -> JobRecord:
        with job_lock_for(job_id):
            job = load_job_or_404(store, job_id)
            if job.approved_state is None or not job.approved_state.user_approved:
                raise HTTPException(
                    status_code=409,
                    detail="Approve corrected state before recording your decision",
                )
            if job.recommendation is not None:
                raise HTTPException(
                    status_code=409,
                    detail="Your decision must be recorded before revealing the recommendation",
                )

            job.training_decision = TrainingDecision(
                action=decision.action,
                sizing=decision.sizing,
            )
            job.training_reviewed_at = None
            job.status = "approved"
            job.error = None
            return store.save(job)

    @app.post("/api/jobs/{job_id}/recommend", response_model=JobRecord)
    def recommend(job_id: str) -> JobRecord:
        with job_lock_for(job_id):
            job = load_job_or_404(store, job_id)
            if job.approved_state is None or not job.approved_state.user_approved:
                raise HTTPException(status_code=409, detail="Approve corrected state before requesting recommendation")
            approved_state = job.approved_state.model_copy(deep=True)

        try:
            provider = build_provider(active_settings)
            missing = missing_required_fields(
                approved_state,
                provider.required_fields_for(approved_state),
            )
        except ProviderConfigurationError as exc:
            with job_lock_for(job_id):
                current = current_recommendation_target(job_id, approved_state)
                current.status = "error"
                current.error = str(exc)
                store.save(current)
            raise HTTPException(status_code=500, detail=f"Provider configuration error: {exc}") from exc

        if missing:
            raise HTTPException(status_code=422, detail={"missing_fields": missing})

        try:
            result = provider.recommend(RecommendationRequest(state=approved_state, provider=provider.name))
        except ProviderInputError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ProviderConfigurationError as exc:
            with job_lock_for(job_id):
                current = current_recommendation_target(job_id, approved_state)
                current.status = "error"
                current.error = str(exc)
                store.save(current)
            raise HTTPException(status_code=500, detail=f"Provider configuration error: {exc}") from exc
        except ProviderError as exc:
            with job_lock_for(job_id):
                current = current_recommendation_target(job_id, approved_state)
                current.status = "error"
                current.error = str(exc)
                store.save(current)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        with job_lock_for(job_id):
            current = current_recommendation_target(job_id, approved_state)
            current.recommendation = result
            current.training_reviewed_at = None
            current.status = "recommended"
            current.error = None
            return store.save(current)

    @app.put("/api/jobs/{job_id}/training-review", response_model=JobRecord)
    def complete_training_review(job_id: str) -> JobRecord:
        with job_lock_for(job_id):
            job = load_job_or_404(store, job_id)
            if job.training_decision is None or job.recommendation is None:
                raise HTTPException(
                    status_code=409,
                    detail="A completed decision comparison is required before review",
                )
            if training_outcome(job) in {"match", "mixed"}:
                raise HTTPException(
                    status_code=409,
                    detail="Exact matches do not need review",
                )
            if job.training_reviewed_at is None:
                job.training_reviewed_at = datetime.now(timezone.utc)
                return store.save(job)
            return job

    @app.delete("/api/jobs/{job_id}/training-review", response_model=JobRecord)
    def reopen_training_review(job_id: str) -> JobRecord:
        with job_lock_for(job_id):
            job = load_job_or_404(store, job_id)
            if job.training_decision is None or job.recommendation is None:
                raise HTTPException(
                    status_code=409,
                    detail="A completed decision comparison is required before reopening review",
                )
            if training_outcome(job) in {"match", "mixed"}:
                raise HTTPException(
                    status_code=409,
                    detail="Exact matches do not need review",
                )
            if job.training_reviewed_at is not None:
                job.training_reviewed_at = None
                return store.save(job)
            return job

    @app.put("/api/jobs/{job_id}/benchmark", response_model=JobRecord)
    def set_benchmark_inclusion(job_id: str, selection: BenchmarkSelectionRequest) -> JobRecord:
        with benchmark_corpus_lock, job_lock_for(job_id):
            job = load_job_or_404(store, job_id)
            if selection.included and (
                job.approved_state is None or not job.approved_state.user_approved
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Approve corrected state before adding it to the benchmark",
                )
            if selection.included and not job.benchmark_included:
                included_cases = sum(
                    candidate.benchmark_included for candidate in store.list()
                )
                if included_cases >= MAX_DATASET_CASES:
                    raise HTTPException(
                        status_code=409,
                        detail=dataset_case_limit_message(MAX_DATASET_CASES),
                    )
                candidate_jobs = [
                    candidate
                    for candidate in store.list()
                    if candidate.benchmark_included and candidate.id != job.id
                ]
                candidate_jobs.append(job)
                try:
                    candidate_archive = build_parser_dataset_archive(
                        jobs=candidate_jobs,
                        image_path_for=store.image_path,
                        parser_provider=active_settings.parser_provider,
                        layout_profile=active_settings.parser_layout_profile,
                        max_archive_bytes=active_settings.max_dataset_upload_bytes,
                    )
                except DatasetExportError as exc:
                    raise HTTPException(status_code=409, detail=str(exc)) from exc
                candidate_archive.close()
            job.benchmark_included = selection.included
            return store.save(job)

    @app.get("/api/training/progress", response_model=TrainingProgress)
    def get_training_progress(
        review_order: TrainingReviewOrder = "recent",
    ) -> TrainingProgress:
        return summarize_training(store.list(), review_order=review_order)

    @app.get("/api/benchmarks", response_model=BenchmarkOverview)
    def get_benchmark_overview() -> BenchmarkOverview:
        included_cases = sum(job.benchmark_included for job in store.list())
        return BenchmarkOverview(
            included_cases=included_cases,
            latest_report=benchmark_store.get_latest(),
            recent_reports=[
                BenchmarkReportSummary.from_report(report)
                for report in benchmark_store.list()
            ],
        )

    @app.get("/api/benchmarks/export")
    def export_benchmark_dataset() -> StreamingResponse:
        with benchmark_corpus_lock:
            jobs = [job for job in store.list() if job.benchmark_included]
            if not jobs:
                raise HTTPException(
                    status_code=409,
                    detail="Add at least one approved hand to the benchmark",
                )
            try:
                archive_file = build_parser_dataset_archive(
                    jobs=jobs,
                    image_path_for=store.image_path,
                    parser_provider=active_settings.parser_provider,
                    layout_profile=active_settings.parser_layout_profile,
                    max_archive_bytes=active_settings.max_dataset_upload_bytes,
                )
            except DatasetExportError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return StreamingResponse(
            stream_archive(archive_file),
            media_type="application/zip",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="poker-hero-parser-dataset-{timestamp}.zip"'
                )
            },
        )

    @app.post(
        "/api/benchmarks/import",
        response_model=BenchmarkDatasetImportResult,
    )
    async def import_benchmark_dataset(
        file: UploadFile = File(...),
    ) -> BenchmarkDatasetImportResult:
        archive_bytes = await file.read(active_settings.max_dataset_upload_bytes + 1)
        if len(archive_bytes) > active_settings.max_dataset_upload_bytes:
            raise HTTPException(status_code=413, detail="Dataset ZIP exceeds maximum size")
        try:
            dataset = parse_parser_dataset_archive(
                archive_bytes,
                max_image_bytes=active_settings.max_upload_bytes,
                max_uncompressed_bytes=(
                    active_settings.max_dataset_upload_bytes
                    * MAX_DATASET_EXPANSION_RATIO
                ),
            )
            lock_indexes = sorted(
                {job_lock_index(case.job_id) for case in dataset.cases}
            )
            with (
                dataset_import_lock,
                benchmark_corpus_lock,
                ExitStack() as job_lock_stack,
            ):
                for lock_index in lock_indexes:
                    job_lock_stack.enter_context(job_locks[lock_index])
                return import_parser_dataset(
                    dataset,
                    store,
                    recommendation_provider=active_settings.recommendation_provider,
                    parser_provider=active_settings.parser_provider,
                    layout_profile=active_settings.parser_layout_profile,
                    max_archive_bytes=active_settings.max_dataset_upload_bytes,
                )
        except DatasetImportError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.get("/api/benchmarks/{report_id}", response_model=BenchmarkReport)
    def get_benchmark_report(report_id: str) -> BenchmarkReport:
        try:
            return benchmark_store.get(report_id)
        except BenchmarkNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Benchmark report not found") from exc

    @app.post("/api/benchmarks/run", response_model=BenchmarkReport)
    def run_parser_benchmark() -> BenchmarkReport:
        jobs = [job for job in store.list() if job.benchmark_included]
        if not jobs:
            raise HTTPException(status_code=409, detail="Add at least one approved hand to the benchmark")
        try:
            parser = build_parser(active_settings)
            report = run_benchmark(
                jobs=jobs,
                parser=parser,
                image_path_for=store.image_path,
                parser_provider=active_settings.parser_provider,
                layout_profile=active_settings.parser_layout_profile,
            )
        except ParserConfigurationError as exc:
            raise HTTPException(status_code=500, detail=f"Parser configuration error: {exc}") from exc
        return benchmark_store.save(report)

    return app


def load_job_or_404(store: FileJobStore, job_id: str) -> JobRecord:
    try:
        return store.get(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc


def is_supported_image(image_bytes: bytes) -> bool:
    if not image_bytes:
        return False
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            image_format = image.format
            image.verify()
            return image_format in SUPPORTED_IMAGE_FORMATS
    except (OSError, SyntaxError, UnidentifiedImageError, ValueError):
        return False


def should_auto_approve(confidences: dict[str, float], settings: Settings) -> bool:
    if not settings.parser_auto_approve_enabled:
        return False
    for field_name, threshold in settings.parser_auto_approve_thresholds.items():
        if confidences.get(field_name, 0) < threshold:
            return False
    return True
