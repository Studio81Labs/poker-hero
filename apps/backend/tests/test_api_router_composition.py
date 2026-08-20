from collections.abc import Callable
from datetime import datetime, timezone
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.dependencies import (
    ApiRuntime,
    HistoryRuntime,
    McpAdminRuntime,
    TrainingProgressQuery,
    TrainingRuntime,
)
from app.api.dependencies import PipelineCapabilitiesUnavailableError
from app.api.routers.health import create_health_router
from app.api.routers.history import create_history_router
from app.api.routers.mcp_admin import create_mcp_admin_router
from app.api.routers.pipeline import create_pipeline_router
from app.api.routers.training import create_training_router
from app.mcp_access import (
    CreateMcpPrincipalRequest,
    McpAccessConfig,
    McpIssuedPrincipal,
    McpPrincipalList,
    McpPrincipalSummary,
)
from app.models import (
    ArchiveJobsRequest,
    HealthResponse,
    JobHistory,
    JobRecord,
    PipelineCapabilities,
    PipelineSelection,
    TrainingProgress,
    TrainingReviewRequest,
)
from app.training import summarize_training


def pipeline_capabilities() -> PipelineCapabilities:
    return PipelineCapabilities(
        defaults=PipelineSelection(
            parser_provider="ocr_cv",
            parser_layout_profile="fortuna",
            recommendation_provider="local_solver",
            recommendation_engine="local_solver",
        ),
        parser_providers=[],
        parser_layout_profiles=[],
        parser_layout_compatibility={},
        recommendation_providers=[],
        recommendation_engines=[],
    )


def health_response() -> HealthResponse:
    return HealthResponse(
        status="ok",
        environment="local",
        parser_provider="ocr_cv",
        recommendation_provider="local_solver",
        recommendation_engine="local_solver",
    )


def job_history() -> JobHistory:
    return JobHistory(total=0, jobs=[], snapshot_version="history-snapshot")


def job_record() -> JobRecord:
    return JobRecord(
        id="a" * 32,
        original_filename="table.png",
        image_filename="table.png",
        parser_provider="ocr_cv",
        recommendation_provider="local_solver",
    )


def training_progress(_query: TrainingProgressQuery) -> TrainingProgress:
    return summarize_training([])


def complete_training_review(
    _job_id: str,
    _review: TrainingReviewRequest | None,
) -> JobRecord:
    return job_record()


def reopen_training_review(_job_id: str) -> JobRecord:
    return job_record()


def export_training_lessons(
    _lesson_order: str,
    _lesson_street: str | None,
    _lesson_query: str | None,
) -> tuple[str, str]:
    return "# Poker Hero Lessons\n", "poker-hero-lessons-20260820T000000Z.md"


def default_training_runtime() -> TrainingRuntime:
    return TrainingRuntime(
        complete_review=complete_training_review,
        reopen_review=reopen_training_review,
        get_progress=training_progress,
        export_lessons=export_training_lessons,
    )


def mcp_config() -> McpAccessConfig:
    return McpAccessConfig(
        enabled=True,
        environment="staging",
        endpoint="https://poker.test/mcp",
        writes_enabled=True,
    )


def mcp_principal() -> McpPrincipalSummary:
    now = datetime(2026, 8, 20, tzinfo=timezone.utc)
    return McpPrincipalSummary(
        id="mcp_" + "a" * 32,
        name="Codex test",
        environment="staging",
        token_prefix="tokenprefix1",
        scopes=["read"],
        status="active",
        created_at=now,
        updated_at=now,
    )


def issued_mcp_principal() -> McpIssuedPrincipal:
    return McpIssuedPrincipal(principal=mcp_principal(), token="phmcp_test")


async def list_mcp_principals() -> McpPrincipalList:
    return McpPrincipalList(principals=[mcp_principal()])


async def create_mcp_principal(
    _request: CreateMcpPrincipalRequest,
) -> McpIssuedPrincipal:
    return issued_mcp_principal()


async def rotate_mcp_principal(_principal_id: str) -> McpIssuedPrincipal:
    return issued_mcp_principal()


async def revoke_mcp_principal(_principal_id: str) -> McpPrincipalSummary:
    return mcp_principal()


def default_mcp_admin_runtime() -> McpAdminRuntime:
    return McpAdminRuntime(
        get_config=mcp_config,
        list_principals=list_mcp_principals,
        create_principal=create_mcp_principal,
        rotate_principal=rotate_mcp_principal,
        revoke_principal=revoke_mcp_principal,
    )


def make_client(
    *,
    get_health: Callable[[], HealthResponse] = health_response,
    get_pipeline_capabilities: Callable[[], PipelineCapabilities] = pipeline_capabilities,
    list_history: Callable[[int, int, str | None], JobHistory] = (
        lambda _limit, _offset, _query: job_history()
    ),
    archive_jobs: Callable[[ArchiveJobsRequest, int], JobHistory] = (
        lambda _request, _limit: job_history()
    ),
    mcp_admin_runtime: McpAdminRuntime | None = None,
    training_runtime: TrainingRuntime | None = None,
) -> TestClient:
    runtime = ApiRuntime(
        get_health=get_health,
        get_pipeline_capabilities=get_pipeline_capabilities,
    )
    history_runtime = HistoryRuntime(
        list_history=list_history,
        archive_jobs=archive_jobs,
    )
    app = FastAPI()
    app.include_router(create_health_router(runtime))
    app.include_router(create_pipeline_router(runtime))
    app.include_router(create_history_router(history_runtime))
    app.include_router(
        create_mcp_admin_router(mcp_admin_runtime or default_mcp_admin_runtime())
    )
    app.include_router(
        create_training_router(training_runtime or default_training_runtime())
    )
    return TestClient(app)


def test_read_only_routers_use_injected_runtime_callables() -> None:
    calls: list[str] = []

    def get_health() -> HealthResponse:
        calls.append("health")
        return health_response()

    def get_pipeline_capabilities() -> PipelineCapabilities:
        calls.append("pipeline")
        return pipeline_capabilities()

    with make_client(
        get_health=get_health,
        get_pipeline_capabilities=get_pipeline_capabilities,
    ) as client:
        health = client.get("/api/health")
        pipeline = client.get("/api/pipeline")

    assert health.status_code == 200
    assert health.json()["environment"] == "local"
    assert pipeline.status_code == 200
    assert pipeline.json()["defaults"]["parser_layout_profile"] == "fortuna"
    assert calls == ["health", "pipeline"]


def test_history_router_forwards_defaults_and_explicit_parameters() -> None:
    calls: list[tuple[object, ...]] = []

    def list_history(limit: int, offset: int, query: str | None) -> JobHistory:
        calls.append(("list", limit, offset, query))
        return job_history()

    def archive_jobs(request: ArchiveJobsRequest, limit: int) -> JobHistory:
        calls.append(("archive", request.job_ids, limit))
        return job_history()

    with make_client(
        list_history=list_history,
        archive_jobs=archive_jobs,
    ) as client:
        default_list = client.get("/api/history")
        explicit_list = client.get(
            "/api/history",
            params={"limit": 7, "offset": 3, "query": "river"},
        )
        default_archive = client.put("/api/history", json={"job_ids": ["a"]})
        explicit_archive = client.put(
            "/api/history?limit=7",
            json={"job_ids": ["a", "b"]},
        )

    assert [response.status_code for response in (
        default_list,
        explicit_list,
        default_archive,
        explicit_archive,
    )] == [200, 200, 200, 200]
    assert default_list.json() == {
        "total": 0,
        "jobs": [],
        "snapshot_version": "history-snapshot",
    }
    assert calls == [
        ("list", 24, 0, None),
        ("list", 7, 3, "river"),
        ("archive", ["a"], 24),
        ("archive", ["a", "b"], 7),
    ]


def test_history_router_preserves_request_validation() -> None:
    with make_client() as client:
        invalid_limit = client.get("/api/history", params={"limit": 101})
        duplicate_job_ids = client.put("/api/history", json={"job_ids": ["a", "a"]})

    assert invalid_limit.status_code == 422
    assert duplicate_job_ids.status_code == 422


def test_history_router_preserves_callback_http_errors() -> None:
    def cannot_archive(_request: ArchiveJobsRequest, _limit: int) -> JobHistory:
        raise HTTPException(status_code=409, detail="History is not ready")

    with make_client(archive_jobs=cannot_archive) as client:
        response = client.put("/api/history", json={"job_ids": ["a"]})

    assert response.status_code == 409
    assert response.json() == {"detail": "History is not ready"}


def test_training_router_delegates_review_progress_and_lesson_export() -> None:
    calls: list[tuple[object, ...]] = []

    def complete_review(
        job_id: str,
        review: TrainingReviewRequest | None,
    ) -> JobRecord:
        calls.append(("complete", job_id, review.note if review else None))
        return job_record()

    def reopen_review(job_id: str) -> JobRecord:
        calls.append(("reopen", job_id))
        return job_record()

    def get_progress(query: TrainingProgressQuery) -> TrainingProgress:
        calls.append(("progress", query))
        return summarize_training([])

    def export_lessons(
        lesson_order: str,
        lesson_street: str | None,
        lesson_query: str | None,
    ) -> tuple[str, str]:
        calls.append(("export", lesson_order, lesson_street, lesson_query))
        return "# Poker Hero Lessons\n", "poker-hero-lessons-20260820T000000Z.md"

    runtime = TrainingRuntime(
        complete_review=complete_review,
        reopen_review=reopen_review,
        get_progress=get_progress,
        export_lessons=export_lessons,
    )
    with make_client(training_runtime=runtime) as client:
        completed = client.put(
            "/api/jobs/job-1/training-review",
            json={"note": "Review blockers"},
        )
        reopened = client.delete("/api/jobs/job-1/training-review")
        progress = client.get(
            "/api/training/progress?review_order=ev_loss&review_street=flop"
            "&review_certainty=high&review_position=button"
            "&review_decision_action=fold&review_recommended_action=call"
            "&lesson_order=ev_loss&lesson_street=turn&lesson_query=blockers"
            f"&solver_fallback_key={'a' * 64}"
        )
        exported = client.get(
            "/api/training/lessons/export?lesson_order=ev_loss"
            "&lesson_street=flop&lesson_query=blockers"
        )

    assert [response.status_code for response in (
        completed,
        reopened,
        progress,
        exported,
    )] == [200, 200, 200, 200]
    assert exported.text == "# Poker Hero Lessons\n"
    assert exported.headers["content-type"] == "text/markdown; charset=utf-8"
    assert exported.headers["content-disposition"] == (
        'attachment; filename="poker-hero-lessons-20260820T000000Z.md"'
    )
    assert calls == [
        ("complete", "job-1", "Review blockers"),
        ("reopen", "job-1"),
        (
            "progress",
            TrainingProgressQuery(
                review_order="ev_loss",
                review_street="flop",
                review_certainty="high",
                review_position="button",
                review_unpositioned=False,
                review_action_difference=("fold", "call"),
                lesson_order="ev_loss",
                lesson_street="turn",
                lesson_query="blockers",
                solver_fallback_key="a" * 64,
                solver_route_key=None,
                solver_unattributed=False,
                recent_street=None,
                recent_position=None,
                recent_unpositioned=False,
                recent_certainty=None,
            ),
        ),
        ("export", "ev_loss", "flop", "blockers"),
    ]


def test_training_router_preserves_query_validation_without_delegating() -> None:
    calls: list[tuple[object, ...]] = []

    def get_progress(query: TrainingProgressQuery) -> TrainingProgress:
        calls.append((query,))
        return summarize_training([])

    runtime = TrainingRuntime(
        complete_review=complete_training_review,
        reopen_review=reopen_training_review,
        get_progress=get_progress,
        export_lessons=export_training_lessons,
    )
    with make_client(training_runtime=runtime) as client:
        incomplete_difference = client.get(
            "/api/training/progress?review_decision_action=fold"
        )
        conflicting_filters = client.get(
            "/api/training/progress?recent_position=button"
            f"&solver_route_key={'b' * 64}"
        )
        invalid_position = client.get("/api/training/progress?review_position=%20")

    assert [response.status_code for response in (
        incomplete_difference,
        conflicting_filters,
        invalid_position,
    )] == [422, 422, 422]
    assert calls == []


def test_training_router_maps_review_and_lesson_export_errors() -> None:
    def missing_review(
        _job_id: str,
        _review: TrainingReviewRequest | None,
    ) -> JobRecord:
        raise KeyError("Job not found")

    def incomplete_reopen(_job_id: str) -> JobRecord:
        raise ValueError(
            "A completed decision comparison is required before reopening review"
        )

    def no_lessons(
        _lesson_order: str,
        _lesson_street: str | None,
        _lesson_query: str | None,
    ) -> tuple[str, str]:
        raise ValueError("No saved lesson notes match the selected filters")

    runtime = TrainingRuntime(
        complete_review=missing_review,
        reopen_review=incomplete_reopen,
        get_progress=training_progress,
        export_lessons=no_lessons,
    )
    with make_client(training_runtime=runtime) as client:
        missing = client.put("/api/jobs/missing/training-review")
        incomplete = client.delete("/api/jobs/job-1/training-review")
        empty_export = client.get("/api/training/lessons/export")

    assert (missing.status_code, missing.json()) == (404, {"detail": "Job not found"})
    assert (incomplete.status_code, incomplete.json()) == (
        409,
        {
            "detail": (
                "A completed decision comparison is required before reopening review"
            )
        },
    )
    assert (empty_export.status_code, empty_export.json()) == (
        409,
        {"detail": "No saved lesson notes match the selected filters"},
    )


def test_mcp_admin_router_forwards_requests_and_preserves_issued_token_cache_rules() -> None:
    calls: list[tuple[object, ...]] = []

    async def list_principals() -> McpPrincipalList:
        calls.append(("list",))
        return McpPrincipalList(principals=[mcp_principal()])

    async def create_principal(
        request: CreateMcpPrincipalRequest,
    ) -> McpIssuedPrincipal:
        calls.append(("create", request.name, request.scopes, request.expires_at))
        return issued_mcp_principal()

    async def rotate_principal(principal_id: str) -> McpIssuedPrincipal:
        calls.append(("rotate", principal_id))
        return issued_mcp_principal()

    async def revoke_principal(principal_id: str) -> McpPrincipalSummary:
        calls.append(("revoke", principal_id))
        return mcp_principal()

    runtime = McpAdminRuntime(
        get_config=mcp_config,
        list_principals=list_principals,
        create_principal=create_principal,
        rotate_principal=rotate_principal,
        revoke_principal=revoke_principal,
    )
    principal_id = mcp_principal().id
    with make_client(mcp_admin_runtime=runtime) as client:
        config = client.get("/api/mcp/config")
        listed = client.get("/api/mcp/principals")
        created = client.post(
            "/api/mcp/principals",
            json={"name": "Codex test", "scopes": ["read"], "expires_at": None},
        )
        rotated = client.post(f"/api/mcp/principals/{principal_id}/rotate")
        revoked = client.delete(f"/api/mcp/principals/{principal_id}")

    assert config.json() == {
        "enabled": True,
        "environment": "staging",
        "endpoint": "https://poker.test/mcp",
        "writes_enabled": True,
    }
    assert listed.json()["principals"][0]["id"] == principal_id
    assert [response.status_code for response in (created, rotated, revoked)] == [
        201,
        201,
        200,
    ]
    assert created.headers["cache-control"] == "no-store"
    assert rotated.headers["cache-control"] == "no-store"
    assert calls == [
        ("list",),
        ("create", "Codex test", ["read"], None),
        ("rotate", principal_id),
        ("revoke", principal_id),
    ]


def test_mcp_admin_router_maps_store_errors_without_changing_callback_policy() -> None:
    async def invalid_create(
        _request: CreateMcpPrincipalRequest,
    ) -> McpIssuedPrincipal:
        raise ValueError("invalid principal")

    async def missing_principal(_principal_id: str) -> McpIssuedPrincipal:
        raise KeyError("MCP principal not found")

    async def inactive_principal(_principal_id: str) -> McpIssuedPrincipal:
        raise ValueError("MCP principal is not active")

    async def missing_revoke(_principal_id: str) -> McpPrincipalSummary:
        raise KeyError("MCP principal not found")

    async def invalid_revoke(_principal_id: str) -> McpPrincipalSummary:
        raise ValueError("invalid principal id")

    with make_client(
        mcp_admin_runtime=McpAdminRuntime(
            get_config=mcp_config,
            list_principals=list_mcp_principals,
            create_principal=invalid_create,
            rotate_principal=missing_principal,
            revoke_principal=missing_revoke,
        )
    ) as client:
        create_error = client.post(
            "/api/mcp/principals",
            json={"name": "Codex test", "scopes": ["read"]},
        )
        rotate_missing = client.post("/api/mcp/principals/mcp_missing/rotate")
        revoke_missing = client.delete("/api/mcp/principals/mcp_missing")

    with make_client(
        mcp_admin_runtime=McpAdminRuntime(
            get_config=mcp_config,
            list_principals=list_mcp_principals,
            create_principal=create_mcp_principal,
            rotate_principal=inactive_principal,
            revoke_principal=invalid_revoke,
        )
    ) as client:
        rotate_inactive = client.post("/api/mcp/principals/mcp_inactive/rotate")
        revoke_invalid = client.delete("/api/mcp/principals/mcp_invalid")

    assert (create_error.status_code, create_error.json()) == (
        400,
        {"detail": "invalid principal"},
    )
    assert (rotate_missing.status_code, rotate_missing.json()) == (
        404,
        {"detail": "MCP principal not found"},
    )
    assert (rotate_inactive.status_code, rotate_inactive.json()) == (
        409,
        {"detail": "MCP principal is not active"},
    )
    assert (revoke_missing.status_code, revoke_missing.json()) == (
        404,
        {"detail": "MCP principal not found"},
    )
    assert (revoke_invalid.status_code, revoke_invalid.json()) == (
        400,
        {"detail": "invalid principal id"},
    )


def test_pipeline_router_preserves_configuration_error_contract() -> None:
    def invalid_pipeline() -> PipelineCapabilities:
        raise PipelineCapabilitiesUnavailableError("missing parser configuration")

    with make_client(get_pipeline_capabilities=invalid_pipeline) as client:
        response = client.get("/api/pipeline")

    assert response.status_code == 500
    assert response.json() == {
        "detail": "Pipeline configuration error: missing parser configuration"
    }


def test_router_composition_preserves_public_operation_ids() -> None:
    with make_client() as client:
        document = client.app.openapi()

    assert document["paths"]["/api/health"]["get"]["operationId"] == "health_get"
    assert document["paths"]["/api/history"]["get"]["operationId"] == "history_get"
    assert document["paths"]["/api/history"]["put"]["operationId"] == "history_archive"
    assert document["paths"]["/api/mcp/config"]["get"]["operationId"] == "mcp_config_get"
    assert (
        document["paths"]["/api/mcp/principals"]["get"]["operationId"]
        == "mcp_principals_list"
    )
    assert (
        document["paths"]["/api/mcp/principals"]["post"]["operationId"]
        == "mcp_principals_create"
    )
    assert (
        document["paths"]["/api/mcp/principals/{principal_id}/rotate"]["post"][
            "operationId"
        ]
        == "mcp_principal_rotate"
    )
    assert (
        document["paths"]["/api/mcp/principals/{principal_id}"]["delete"][
            "operationId"
        ]
        == "mcp_principal_revoke"
    )
    assert document["paths"]["/api/pipeline"]["get"]["operationId"] == "pipeline_get"
    assert (
        document["paths"]["/api/jobs/{job_id}/training-review"]["put"][
            "operationId"
        ]
        == "job_training_review_complete"
    )
    assert (
        document["paths"]["/api/jobs/{job_id}/training-review"]["delete"][
            "operationId"
        ]
        == "job_training_review_reopen"
    )
    assert (
        document["paths"]["/api/training/progress"]["get"]["operationId"]
        == "training_progress_get"
    )
    assert (
        document["paths"]["/api/training/lessons/export"]["get"]["operationId"]
        == "training_lessons_export"
    )


def test_router_imports_do_not_initialize_the_legacy_bootstrap() -> None:
    program = """
import importlib
import sys

importlib.import_module('app.api.routers.health')
importlib.import_module('app.api.routers.history')
importlib.import_module('app.api.routers.mcp_admin')
importlib.import_module('app.api.routers.pipeline')
importlib.import_module('app.api.routers.training')

for module_name in (
    'app.bootstrap',
    'app.storage',
    'app.parsers.registry',
    'app.providers.registry',
    'app.solvers.registry',
):
    assert module_name not in sys.modules, module_name
"""
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_public_api_facade_retains_bootstrap_factory_compatibility() -> None:
    from app import api
    from app import bootstrap

    assert api.create_app is bootstrap.create_app
    assert api.create_openapi_document is bootstrap.create_openapi_document
