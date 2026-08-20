from collections.abc import Callable
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import ApiRuntime
from app.api.dependencies import PipelineCapabilitiesUnavailableError
from app.api.routers.health import create_health_router
from app.api.routers.pipeline import create_pipeline_router
from app.models import HealthResponse, PipelineCapabilities, PipelineSelection


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


def make_client(
    *,
    get_health: Callable[[], HealthResponse] = health_response,
    get_pipeline_capabilities: Callable[[], PipelineCapabilities] = pipeline_capabilities,
) -> TestClient:
    runtime = ApiRuntime(
        get_health=get_health,
        get_pipeline_capabilities=get_pipeline_capabilities,
    )
    app = FastAPI()
    app.include_router(create_health_router(runtime))
    app.include_router(create_pipeline_router(runtime))
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
    assert document["paths"]["/api/pipeline"]["get"]["operationId"] == "pipeline_get"


def test_router_imports_do_not_initialize_the_legacy_bootstrap() -> None:
    program = """
import importlib
import sys

importlib.import_module('app.api.routers.health')
importlib.import_module('app.api.routers.pipeline')

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
