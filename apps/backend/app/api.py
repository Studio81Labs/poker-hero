from io import BytesIO

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError

from app.config import Settings, get_settings
from app.benchmarking import run_benchmark
from app.models import (
    BenchmarkOverview,
    BenchmarkReport,
    BenchmarkReportSummary,
    BenchmarkSelectionRequest,
    CanonicalState,
    JobRecord,
    RecommendationRequest,
    TrainingDecision,
    TrainingDecisionRequest,
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

SUPPORTED_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}


def create_app(settings: Settings | None = None) -> FastAPI:
    active_settings = settings or get_settings()
    store = FileJobStore(active_settings.data_dir)
    benchmark_store = FileBenchmarkStore(active_settings.data_dir)
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
        job = load_job_or_404(store, job_id)
        state.user_approved = True
        job.approved_state = state
        job.training_decision = None
        job.recommendation = None
        job.status = "approved"
        job.error = None
        return store.save(job)

    @app.put("/api/jobs/{job_id}/decision", response_model=JobRecord)
    def record_training_decision(
        job_id: str,
        decision: TrainingDecisionRequest,
    ) -> JobRecord:
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
        job.status = "approved"
        job.error = None
        return store.save(job)

    @app.post("/api/jobs/{job_id}/recommend", response_model=JobRecord)
    def recommend(job_id: str) -> JobRecord:
        job = load_job_or_404(store, job_id)
        if job.approved_state is None or not job.approved_state.user_approved:
            raise HTTPException(status_code=409, detail="Approve corrected state before requesting recommendation")

        try:
            provider = build_provider(active_settings)
            missing = missing_required_fields(
                job.approved_state,
                provider.required_fields_for(job.approved_state),
            )
        except ProviderConfigurationError as exc:
            job.status = "error"
            job.error = str(exc)
            store.save(job)
            raise HTTPException(status_code=500, detail=f"Provider configuration error: {exc}") from exc

        if missing:
            raise HTTPException(status_code=422, detail={"missing_fields": missing})

        try:
            result = provider.recommend(RecommendationRequest(state=job.approved_state, provider=provider.name))
        except ProviderInputError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ProviderConfigurationError as exc:
            job.status = "error"
            job.error = str(exc)
            store.save(job)
            raise HTTPException(status_code=500, detail=f"Provider configuration error: {exc}") from exc
        except ProviderError as exc:
            job.status = "error"
            job.error = str(exc)
            store.save(job)
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        job.recommendation = result
        job.status = "recommended"
        job.error = None
        return store.save(job)

    @app.put("/api/jobs/{job_id}/benchmark", response_model=JobRecord)
    def set_benchmark_inclusion(job_id: str, selection: BenchmarkSelectionRequest) -> JobRecord:
        job = load_job_or_404(store, job_id)
        if selection.included and (
            job.approved_state is None or not job.approved_state.user_approved
        ):
            raise HTTPException(
                status_code=409,
                detail="Approve corrected state before adding it to the benchmark",
            )
        job.benchmark_included = selection.included
        return store.save(job)

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
