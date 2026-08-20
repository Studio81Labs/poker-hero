"""Read-only processing job transport endpoints."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.api.dependencies import JobReadNotFoundError, JobsReadRuntime
from app.api.response_contracts import SUPPORTED_IMAGE_RESPONSE_CONTENT
from app.models import JobQueue, JobRecord


def create_jobs_router(runtime: JobsReadRuntime) -> APIRouter:
    """Build the processing job read router with application dependencies."""

    router = APIRouter()

    @router.get("/api/jobs", operation_id="jobs_list", response_model=JobQueue)
    def get_processing_jobs(
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ) -> JobQueue:
        return runtime.list_jobs(limit, offset)

    @router.get(
        "/api/jobs/{job_id}",
        operation_id="job_get",
        response_model=JobRecord,
    )
    def get_job(job_id: str) -> JobRecord:
        try:
            return runtime.get_job(job_id)
        except JobReadNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get(
        "/api/jobs/{job_id}/image",
        operation_id="job_image_get",
        response_class=Response,
        responses={"200": {"content": SUPPORTED_IMAGE_RESPONSE_CONTENT}},
    )
    def get_job_image(job_id: str) -> Response:
        try:
            image = runtime.get_image(job_id)
        except JobReadNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return Response(content=image.content, media_type=image.media_type)

    return router
