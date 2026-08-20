"""Processing job transport endpoints."""

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response

from app.api.dependencies import (
    JobMutationConflictError,
    JobTransportNotFoundError,
    JobsMutationRuntime,
    JobsReadRuntime,
)
from app.api.response_contracts import SUPPORTED_IMAGE_RESPONSE_CONTENT
from app.models import (
    CanonicalState,
    JobQueue,
    JobRecord,
    ScreenshotMetadataRequest,
    TrainingDecisionRequest,
)


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
        except JobTransportNotFoundError as exc:
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
        except JobTransportNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return Response(content=image.content, media_type=image.media_type)

    return router


def create_job_mutations_router(runtime: JobsMutationRuntime) -> APIRouter:
    """Build the processing job mutation router with application dependencies."""

    router = APIRouter()

    @router.put(
        "/api/jobs/{job_id}/metadata",
        operation_id="job_metadata_update",
        response_model=JobRecord,
    )
    def update_job_metadata(
        job_id: str,
        metadata: ScreenshotMetadataRequest,
    ) -> JobRecord:
        try:
            return runtime.update_metadata(job_id, metadata)
        except JobTransportNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.delete(
        "/api/jobs/{job_id}",
        operation_id="job_delete",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    def delete_job(job_id: str) -> Response:
        try:
            runtime.delete_job(job_id)
        except JobTransportNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except JobMutationConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/api/jobs/{job_id}/approve",
        operation_id="job_approve",
        response_model=JobRecord,
    )
    def approve_job(job_id: str, state: CanonicalState) -> JobRecord:
        try:
            return runtime.approve_job(job_id, state)
        except JobTransportNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except JobMutationConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.put(
        "/api/jobs/{job_id}/decision",
        operation_id="job_decision_record",
        response_model=JobRecord,
    )
    def record_training_decision(
        job_id: str,
        decision: TrainingDecisionRequest,
    ) -> JobRecord:
        try:
            return runtime.record_training_decision(job_id, decision)
        except JobTransportNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except JobMutationConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return router
