from contextlib import ExitStack
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import re
from threading import Lock, RLock

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, status
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
    ArchiveJobsRequest,
    BenchmarkDatasetImportResult,
    BenchmarkOverview,
    BenchmarkReport,
    BenchmarkReportSummary,
    BenchmarkSelectionRequest,
    CanonicalState,
    JobHistory,
    JobQueue,
    JobRecord,
    RecommendationAction,
    RecommendationRequest,
    Street,
    TrainingDecision,
    TrainingDecisionRequest,
    TrainingProgress,
    TrainingReviewCertainty,
    TrainingReviewOrder,
    TrainingReviewRequest,
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
from app.training import (
    build_training_lessons_markdown,
    summarize_training,
    training_outcome,
)

SUPPORTED_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}
JOB_LOCK_STRIPES = 64
HISTORY_QUERY_TRANSLATION = str.maketrans({
    "♣": "c",
    "♦": "d",
    "♥": "h",
    "♠": "s",
    "\ufe0e": None,
    "\ufe0f": None,
})
HISTORY_PRESENTATION_SELECTOR_TRANSLATION = str.maketrans({
    "\ufe0e": None,
    "\ufe0f": None,
})
HISTORY_CARD_QUERY_TOKEN_PATTERN = re.compile(
    r"(?i:(?:[2-9tjqka]|10)[cdhs♣♦♥♠])",
)
HISTORY_LOWERCASE_FACE_CARD_QUERY_PATTERN = re.compile(r"[tjqka][cdhs]")
HISTORY_QUERY_SEPARATOR_PATTERN = re.compile(r"[,\s]+")


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or get_settings()
    store = FileJobStore(active_settings.data_dir)
    benchmark_store = FileBenchmarkStore(active_settings.data_dir)
    # Fixed stripes serialize each job without retaining caller-supplied IDs.
    job_locks = tuple(Lock() for _ in range(JOB_LOCK_STRIPES))
    history_lock = RLock()
    dataset_import_lock = Lock()
    benchmark_corpus_lock = Lock()

    def job_lock_index(job_id: str) -> int:
        return hash(job_id) % len(job_locks)

    def job_lock_for(job_id: str):
        return job_locks[job_lock_index(job_id)]

    def save_job(job: JobRecord) -> JobRecord:
        if job.archived_at is None:
            return store.save(job)
        with history_lock:
            return store.save(job)

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
            save_job(job)
            raise HTTPException(status_code=500, detail=f"Parser configuration error: {exc}") from exc
        except ParserError as exc:
            job.status = "error"
            job.error = str(exc)
            save_job(job)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        job.parser_result = parser_result
        job.status = "parsed"
        if should_auto_approve(parser_result.confidences, active_settings):
            job.approved_state = CanonicalState.from_parser_result(parser_result)
            job.approved_state.user_approved = True
            job.status = "approved"
        return save_job(job)

    @app.get("/api/jobs", response_model=JobQueue)
    def get_processing_jobs(
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ) -> JobQueue:
        return build_job_queue(store, limit, offset)

    @app.get("/api/jobs/{job_id}", response_model=JobRecord)
    def get_job(job_id: str) -> JobRecord:
        return load_job_or_404(store, job_id)

    @app.get("/api/history", response_model=JobHistory)
    def get_history(
        limit: int = Query(default=24, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        query: str | None = Query(default=None, max_length=100),
    ) -> JobHistory:
        with history_lock:
            return build_job_history(store, limit, offset, query)

    @app.put("/api/history", response_model=JobHistory)
    def archive_jobs(
        request: ArchiveJobsRequest,
        limit: int = Query(default=24, ge=1, le=100),
    ) -> JobHistory:
        lock_indexes = sorted({job_lock_index(job_id) for job_id in request.job_ids})
        with ExitStack() as job_lock_stack:
            for lock_index in lock_indexes:
                job_lock_stack.enter_context(job_locks[lock_index])

            jobs = [load_job_or_404(store, job_id) for job_id in request.job_ids]
            if any(not is_history_ready(job) for job in jobs):
                raise HTTPException(
                    status_code=409,
                    detail="Only approved or recommended jobs can be moved to history",
                )

            with history_lock:
                archived_at = datetime.now(timezone.utc)
                for job in jobs:
                    if job.archived_at is None:
                        job.archived_at = archived_at
                        store.save(job)
                return build_job_history(store, limit)

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
            job.training_review_note = None
            job.status = "approved"
            job.error = None
            return save_job(job)

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
                certainty=decision.certainty,
            )
            job.training_reviewed_at = None
            job.training_review_note = None
            job.status = "approved"
            job.error = None
            return save_job(job)

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
                save_job(current)
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
                save_job(current)
            raise HTTPException(status_code=500, detail=f"Provider configuration error: {exc}") from exc
        except ProviderError as exc:
            with job_lock_for(job_id):
                current = current_recommendation_target(job_id, approved_state)
                current.status = "error"
                current.error = str(exc)
                save_job(current)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        with job_lock_for(job_id):
            current = current_recommendation_target(job_id, approved_state)
            current.recommendation = result
            current.training_reviewed_at = None
            current.training_review_note = None
            current.status = "recommended"
            current.error = None
            return save_job(current)

    @app.put("/api/jobs/{job_id}/training-review", response_model=JobRecord)
    def complete_training_review(
        job_id: str,
        review: TrainingReviewRequest | None = None,
    ) -> JobRecord:
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
            changed = False
            if job.training_reviewed_at is None:
                job.training_reviewed_at = datetime.now(timezone.utc)
                changed = True
            if review is not None and job.training_review_note != review.note:
                job.training_review_note = review.note
                changed = True
            if changed:
                return save_job(job)
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
                return save_job(job)
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
            return save_job(job)

    @app.get("/api/training/progress", response_model=TrainingProgress)
    def get_training_progress(
        review_order: TrainingReviewOrder = "recent",
        review_street: Street | None = None,
        review_certainty: TrainingReviewCertainty | None = None,
        review_position: str | None = Query(
            default=None,
            min_length=1,
            max_length=120,
            pattern=r".*\S.*",
        ),
        review_unpositioned: bool = False,
        review_decision_action: RecommendationAction | None = None,
        review_recommended_action: RecommendationAction | None = None,
        lesson_order: TrainingReviewOrder = "recent",
        lesson_street: Street | None = None,
        lesson_query: str | None = Query(default=None, max_length=120),
        solver_fallback_key: str | None = Query(
            default=None,
            pattern=r"^[0-9a-f]{64}$",
        ),
        solver_route_key: str | None = Query(
            default=None,
            pattern=r"^[0-9a-f]{64}$",
        ),
        solver_unattributed: bool = False,
        recent_street: Street | None = None,
        recent_position: str | None = Query(
            default=None,
            min_length=1,
            max_length=120,
            pattern=r".*\S.*",
        ),
        recent_unpositioned: bool = False,
        recent_certainty: TrainingReviewCertainty | None = None,
    ) -> TrainingProgress:
        if (review_decision_action is None) != (review_recommended_action is None):
            raise HTTPException(
                status_code=422,
                detail=(
                    "review_decision_action and review_recommended_action "
                    "must be provided together"
                ),
            )
        if review_position is not None and review_unpositioned:
            raise HTTPException(
                status_code=422,
                detail=(
                    "review_position and review_unpositioned "
                    "are mutually exclusive"
                ),
            )
        solver_filter_count = sum((
            solver_fallback_key is not None,
            solver_route_key is not None,
            solver_unattributed,
        ))
        if solver_filter_count > 1:
            raise HTTPException(
                status_code=422,
                detail=(
                    "solver_fallback_key, solver_route_key, and "
                    "solver_unattributed are mutually exclusive"
                ),
            )
        position_filter_count = sum((
            recent_position is not None,
            recent_unpositioned,
        ))
        if position_filter_count > 1:
            raise HTTPException(
                status_code=422,
                detail=(
                    "recent_position and recent_unpositioned "
                    "are mutually exclusive"
                ),
            )
        if position_filter_count > 0 and solver_filter_count > 0:
            raise HTTPException(
                status_code=422,
                detail=(
                    "position and solver recent-hand filters "
                    "are mutually exclusive"
                ),
            )
        if recent_street is not None and (
            position_filter_count > 0 or solver_filter_count > 0
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "street, position, and solver recent-hand filters "
                    "are mutually exclusive"
                ),
            )
        if recent_certainty is not None and (
            recent_street is not None
            or position_filter_count > 0
            or solver_filter_count > 0
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "certainty, street, position, and solver recent-hand "
                    "filters are mutually exclusive"
                ),
            )
        review_action_difference = (
            (review_decision_action, review_recommended_action)
            if review_decision_action is not None
            and review_recommended_action is not None
            else None
        )
        return summarize_training(
            store.list(),
            review_order=review_order,
            review_street=review_street,
            review_certainty=review_certainty,
            review_position=review_position,
            review_unpositioned=review_unpositioned,
            review_action_difference=review_action_difference,
            lesson_street=lesson_street,
            lesson_query=lesson_query,
            lesson_order=lesson_order,
            solver_fallback_key=solver_fallback_key,
            solver_route_key=solver_route_key,
            solver_unattributed=solver_unattributed,
            recent_street=recent_street,
            recent_position=recent_position,
            recent_unpositioned=recent_unpositioned,
            recent_certainty=recent_certainty,
        )

    @app.get("/api/training/lessons/export")
    def export_training_lessons(
        lesson_order: TrainingReviewOrder = "recent",
        lesson_street: Street | None = None,
        lesson_query: str | None = Query(default=None, max_length=120),
    ) -> StreamingResponse:
        document, lesson_count = build_training_lessons_markdown(
            store.list(),
            lesson_street=lesson_street,
            lesson_query=lesson_query,
            lesson_order=lesson_order,
        )
        if lesson_count == 0:
            raise HTTPException(
                status_code=409,
                detail="No saved lesson notes match the selected filters",
            )
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return StreamingResponse(
            iter([document]),
            media_type="text/markdown",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="poker-hero-lessons-{timestamp}.md"'
                )
            },
        )

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
                with history_lock:
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


def is_history_ready(job: JobRecord) -> bool:
    return (
        job.status in {"approved", "recommended"}
        or job.approved_state is not None
        or job.recommendation is not None
    )


def build_job_queue(
    store: FileJobStore,
    limit: int,
    offset: int = 0,
) -> JobQueue:
    processing_jobs = sorted(
        (
            job
            for job in store.list()
            if job.archived_at is None
            and not (
                job.benchmark_included
                and job.parser_result is None
                and job.recommendation is None
            )
        ),
        key=lambda job: (job.created_at, job.id),
    )
    return JobQueue(
        total=len(processing_jobs),
        jobs=processing_jobs[offset : offset + limit],
        snapshot_version=job_snapshot_version(processing_jobs),
    )


def build_job_history(
    store: FileJobStore,
    limit: int,
    offset: int = 0,
    query: str | None = None,
) -> JobHistory:
    archived_jobs = sorted(
        (job for job in store.list() if job.archived_at is not None),
        key=lambda job: (job.archived_at, job.created_at),
        reverse=True,
    )
    query_terms = history_query_terms(query)
    if query_terms:
        archived_jobs = [
            job
            for job in archived_jobs
            if history_matches_query(job, query_terms)
        ]
    elif query is not None and query.strip():
        archived_jobs = []
    return JobHistory(
        total=len(archived_jobs),
        jobs=archived_jobs[offset : offset + limit],
        snapshot_version=job_snapshot_version(archived_jobs),
    )


def job_snapshot_version(jobs: list[JobRecord]) -> str:
    digest = sha256()
    for job in jobs:
        digest.update(job.id.encode())
        digest.update(b"\0")
        digest.update(job.updated_at.isoformat().encode())
        digest.update(b"\0")
        digest.update((job.archived_at.isoformat() if job.archived_at else "").encode())
        digest.update(b"\n")
    return digest.hexdigest()


def normalize_history_query(value: str | None) -> str:
    return (value or "").translate(HISTORY_QUERY_TRANSLATION).casefold().strip()


def compact_history_card_terms(value: str) -> list[str] | None:
    matches = list(HISTORY_CARD_QUERY_TOKEN_PATTERN.finditer(value))
    if (
        not matches
        or matches[0].start() != 0
        or matches[-1].end() != len(value)
        or any(
            previous.end() != current.start()
            for previous, current in zip(matches, matches[1:])
        )
    ):
        return None
    return [normalize_history_query(match.group()) for match in matches]


def history_query_terms(value: str | None) -> list[tuple[str, bool]]:
    query_value = (value or "").translate(
        HISTORY_PRESENTATION_SELECTOR_TRANSLATION
    )
    raw_terms = [
        raw_term
        for raw_term in HISTORY_QUERY_SEPARATOR_PATTERN.split(query_value)
        if raw_term
    ]
    card_term_groups = [
        compact_history_card_terms(raw_term)
        for raw_term in raw_terms
    ]
    card_term_count = sum(
        len(card_terms)
        for card_terms in card_term_groups
        if card_terms is not None
    )
    terms: list[tuple[str, bool]] = []
    for raw_term, card_terms in zip(raw_terms, card_term_groups):
        lowercase_singleton_is_prose = (
            card_term_count == 1
            and HISTORY_LOWERCASE_FACE_CARD_QUERY_PATTERN.fullmatch(raw_term)
            is not None
        )
        if card_terms is not None and not lowercase_singleton_is_prose:
            terms.extend((card_term, True) for card_term in card_terms)
            continue
        normalized_term = normalize_history_query(raw_term)
        if not normalized_term:
            continue
        terms.append((normalized_term, False))
    return terms


def history_matches_query(
    job: JobRecord,
    query_terms: list[tuple[str, bool]],
) -> bool:
    search_text = history_search_text(job)
    card_tokens = history_card_tokens(job)
    return all(
        term in card_tokens
        if is_card
        else term in search_text
        for term, is_card in query_terms
    )


def history_card_tokens(job: JobRecord) -> set[str]:
    state = job.approved_state or (job.parser_result.state if job.parser_result else None)
    if state is None:
        return set()
    tokens = {card.code.casefold() for card in [*state.hero_cards, *state.board_cards]}
    tokens.update(
        f"10{token[1:]}"
        for token in tuple(tokens)
        if token.startswith("t")
    )
    return tokens


def history_search_text(job: JobRecord) -> str:
    state = job.approved_state or (job.parser_result.state if job.parser_result else None)
    values: list[str] = [
        job.original_filename,
        job.status,
        job.parser_provider,
        job.recommendation_provider,
    ]
    if state is not None:
        values.extend(
            value
            for value in [
                state.street,
                state.hero_position,
                state.preflop_opener_position,
                state.facing_action,
                state.action_context,
            ]
            if value is not None
        )
        for card in [*state.hero_cards, *state.board_cards]:
            values.extend([card.code, card.rank, card.suit])
            if card.rank == "T":
                values.append(f"10{card.code[1:]}")
    if job.training_decision is not None:
        values.extend([
            job.training_decision.action,
            job.training_decision.certainty or "",
        ])
        if job.training_decision.sizing is not None:
            values.append(str(job.training_decision.sizing))
    if job.recommendation is not None:
        values.extend([
            job.recommendation.action,
            job.recommendation.explanation,
        ])
        if job.recommendation.sizing is not None:
            values.append(str(job.recommendation.sizing))
    if job.training_review_note:
        values.append(job.training_review_note)
    return normalize_history_query(" ".join(values))


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
