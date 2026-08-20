from pathlib import Path

from app.api import create_openapi_document
from app.config import Settings


EXPECTED_OPERATION_IDS = {
    ("DELETE", "/api/jobs/{job_id}"): "job_delete",
    ("DELETE", "/api/jobs/{job_id}/training-review"): "job_training_review_reopen",
    ("DELETE", "/api/mcp/principals/{principal_id}"): "mcp_principal_revoke",
    ("GET", "/api/backups/export"): "backups_export",
    ("GET", "/api/benchmarks"): "benchmarks_get",
    ("GET", "/api/benchmarks/export"): "benchmarks_export",
    ("GET", "/api/benchmarks/imports/{request_id}"): "benchmark_import_get",
    ("GET", "/api/benchmarks/{report_id}"): "benchmark_report_get",
    ("GET", "/api/health"): "health_get",
    ("GET", "/api/history"): "history_get",
    ("GET", "/api/jobs"): "jobs_list",
    ("GET", "/api/jobs/{job_id}"): "job_get",
    ("GET", "/api/jobs/{job_id}/image"): "job_image_get",
    ("GET", "/api/mcp/config"): "mcp_config_get",
    ("GET", "/api/mcp/principals"): "mcp_principals_list",
    ("GET", "/api/pipeline"): "pipeline_get",
    ("GET", "/api/training/lessons/export"): "training_lessons_export",
    ("GET", "/api/training/progress"): "training_progress_get",
    ("POST", "/api/backups/restore"): "backups_restore",
    ("POST", "/api/benchmarks/import"): "benchmarks_import",
    ("POST", "/api/benchmarks/run"): "benchmarks_run",
    ("POST", "/api/jobs"): "jobs_create",
    ("POST", "/api/jobs/{job_id}/approve"): "job_approve",
    ("POST", "/api/jobs/{job_id}/recommend"): "job_recommend",
    ("POST", "/api/mcp/principals"): "mcp_principals_create",
    ("POST", "/api/mcp/principals/{principal_id}/rotate"): "mcp_principal_rotate",
    ("PUT", "/api/history"): "history_archive",
    ("PUT", "/api/jobs/{job_id}/benchmark"): "job_benchmark_update",
    ("PUT", "/api/jobs/{job_id}/decision"): "job_decision_record",
    ("PUT", "/api/jobs/{job_id}/metadata"): "job_metadata_update",
    ("PUT", "/api/jobs/{job_id}/training-review"): "job_training_review_complete",
}


def openapi_document(tmp_path: Path) -> dict:
    return create_openapi_document(Settings(data_dir=tmp_path))


def test_public_operation_ids_are_unique_and_stable(tmp_path: Path) -> None:
    document = openapi_document(tmp_path)
    operation_ids = {
        (method.upper(), path): operation["operationId"]
        for path, path_item in document["paths"].items()
        for method, operation in path_item.items()
    }

    assert operation_ids == EXPECTED_OPERATION_IDS
    assert len(set(operation_ids.values())) == len(operation_ids)


def test_health_response_schema_is_explicit(tmp_path: Path) -> None:
    document = openapi_document(tmp_path)
    response_schema = document["paths"]["/api/health"]["get"]["responses"]["200"]
    health_schema = document["components"]["schemas"]["HealthResponse"]

    assert response_schema["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HealthResponse"
    }
    assert health_schema["required"] == [
        "status",
        "environment",
        "parser_provider",
        "recommendation_provider",
        "recommendation_engine",
    ]
    assert health_schema["properties"]["status"] == {
        "const": "ok",
        "title": "Status",
        "type": "string",
    }
