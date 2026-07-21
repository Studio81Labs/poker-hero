import base64
import os
from pathlib import Path
from threading import Event, Lock as ThreadLock, Thread

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings
from app.parsers.base import ParserConfigurationError, ParserError
from app.parsers.mock import MockParser
from app.providers.base import ProviderError
from app.providers.mock import MockRecommendationProvider
from app.storage import FileBenchmarkStore, FileJobStore, JobNotFoundError


VALID_PNG = (
    base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
        "AAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="
    )
)

APPROVED_STATE = {
    "hero_cards": [{"rank": "A", "suit": "hearts"}, {"rank": "K", "suit": "diamonds"}],
    "board_cards": [
        {"rank": "Q", "suit": "spades"},
        {"rank": "J", "suit": "clubs"},
        {"rank": "2", "suit": "hearts"},
    ],
    "pot_size": 12.5,
    "current_bet": 2.5,
    "hero_stack": 97.5,
    "effective_stack": 96.0,
    "players_in_hand": 3,
    "hero_position": "button",
    "street": "flop",
    "facing_action": "bet",
    "action_context": "Cutoff bet 2.5 into 12.5",
    "user_approved": True,
}


def make_client(tmp_path: Path, **settings_overrides: object) -> TestClient:
    settings_values = {
        "data_dir": tmp_path,
        "parser_provider": "mock",
        "recommendation_provider": "mock",
    }
    settings_values.update(settings_overrides)
    app = create_app(Settings(**settings_values))
    return TestClient(app)


def upload_job(
    client: TestClient,
    content: bytes = VALID_PNG,
    content_type: str = "image/png",
    filename: str = "table.png",
):
    return client.post("/api/jobs", files={"file": (filename, content, content_type)})


def approve_job(client: TestClient, job_id: str, state: dict[str, object] | None = None):
    return client.post(f"/api/jobs/{job_id}/approve", json=state or APPROVED_STATE)


def load_only_job(tmp_path: Path):
    job_dirs = list((tmp_path / "jobs").iterdir())
    assert len(job_dirs) == 1
    return FileJobStore(tmp_path).get(job_dirs[0].name)


def test_health_reports_active_local_solver_engine(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        recommendation_provider="local_solver",
        local_solver_engine="postflop_solver",
    )

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "parser_provider": "mock",
        "recommendation_provider": "local_solver",
        "recommendation_engine": "postflop_solver",
    }


def test_upload_parse_approve_and_recommend(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    upload = upload_job(client)

    assert upload.status_code == 201
    job = upload.json()
    assert job["status"] == "parsed"
    assert job["parser_result"]["state"]["hero_cards"][0]["rank"] == "A"
    assert job["parser_result"]["confidences"]["hero_cards"] == 0.99

    approve = approve_job(client, job["id"])

    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    recommend = client.post(f"/api/jobs/{job['id']}/recommend")

    assert recommend.status_code == 200
    result = recommend.json()
    assert result["status"] == "recommended"
    assert result["recommendation"]["action"] == "call"
    assert result["recommendation"]["sizing"] is None


def test_reapproval_clears_previous_recommendation(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 7.5},
    )
    client.post(f"/api/jobs/{job_id}/recommend")

    corrected_state = {**APPROVED_STATE, "pot_size": 18.0}
    response = approve_job(client, job_id, corrected_state)

    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "approved"
    assert job["approved_state"]["pot_size"] == 18.0
    assert job["training_decision"] is None
    assert job["recommendation"] is None
    assert FileJobStore(tmp_path).get(job_id).recommendation is None


def test_records_training_decision_before_recommendation(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 7.5},
    )

    assert response.status_code == 200
    decision = response.json()["training_decision"]
    assert decision["action"] == "raise"
    assert decision["sizing"] == 7.5
    assert decision["recorded_at"]
    assert FileJobStore(tmp_path).get(job_id).training_decision.action == "raise"


def test_training_progress_reports_completed_decision_reviews(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": None},
    )
    client.post(f"/api/jobs/{job_id}/recommend")

    response = client.get("/api/training/progress")

    assert response.status_code == 200
    progress = response.json()
    assert progress["reviewed_hands"] == 1
    assert progress["action_matches"] == 1
    assert progress["exact_matches"] == 1
    assert progress["different_actions"] == 0
    assert progress["action_accuracy"] == 1
    assert progress["exact_accuracy"] == 1
    assert progress["street_summaries"][0]["street"] == "flop"
    assert progress["recent_hands"][0]["job_id"] == job_id
    assert progress["recent_hands"][0]["outcome"] == "match"


def test_training_decision_requires_approval_and_precedes_recommendation(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]

    before_approval = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": None},
    )
    assert before_approval.status_code == 409
    assert before_approval.json()["detail"] == (
        "Approve corrected state before recording your decision"
    )

    approve_job(client, job_id)
    client.post(f"/api/jobs/{job_id}/recommend")
    after_recommendation = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": None},
    )
    assert after_recommendation.status_code == 409
    assert after_recommendation.json()["detail"] == (
        "Your decision must be recorded before revealing the recommendation"
    )


def test_training_decision_rejects_sizing_for_non_wager_action(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": 2.5},
    )

    assert response.status_code == 422
    assert FileJobStore(tmp_path).get(job_id).training_decision is None


def test_recommendation_preserves_decision_recorded_while_provider_runs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_started = Event()
    release_provider = Event()

    class SlowRecommendationProvider(MockRecommendationProvider):
        def recommend(self, request):
            provider_started.set()
            if not release_provider.wait(timeout=5):
                raise ProviderError("test provider timed out")
            return super().recommend(request)

    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    monkeypatch.setattr(
        "app.api.build_provider",
        lambda settings: SlowRecommendationProvider(),
    )
    recommendation_responses = []
    recommendation_thread = Thread(
        target=lambda: recommendation_responses.append(
            client.post(f"/api/jobs/{job_id}/recommend")
        )
    )

    recommendation_thread.start()
    try:
        assert provider_started.wait(timeout=2)
        decision_response = client.put(
            f"/api/jobs/{job_id}/decision",
            json={"action": "raise", "sizing": 7.5},
        )
        assert decision_response.status_code == 200
    finally:
        release_provider.set()
        recommendation_thread.join(timeout=5)

    assert not recommendation_thread.is_alive()
    assert len(recommendation_responses) == 1
    recommendation_response = recommendation_responses[0]
    assert recommendation_response.status_code == 200
    job = recommendation_response.json()
    assert job["status"] == "recommended"
    assert job["training_decision"]["action"] == "raise"
    assert job["training_decision"]["sizing"] == 7.5
    persisted_job = FileJobStore(tmp_path).get(job_id)
    assert persisted_job.training_decision.action == "raise"
    assert persisted_job.recommendation is not None


def test_recommend_requires_approval(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    upload = upload_job(client)
    job_id = upload.json()["id"]

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 409
    assert response.json()["detail"] == "Approve corrected state before requesting recommendation"


def test_job_image_endpoint_returns_upload(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    upload = upload_job(client)
    job_id = upload.json()["id"]

    image_response = client.get(f"/api/jobs/{job_id}/image")

    assert image_response.status_code == 200
    assert image_response.content == VALID_PNG


@pytest.mark.parametrize(
    "content",
    [
        b"this is text pretending to be a png",
        b"\x89PNG\r\n\x1a\nnot actually a png",
        b"\xff\xd8\xffnot actually a jpeg",
    ],
)
def test_upload_rejects_spoofed_image_content(tmp_path: Path, content: bytes) -> None:
    client = make_client(tmp_path)

    response = upload_job(client, content=content)

    assert response.status_code == 400
    assert response.json()["detail"] == "Upload must contain supported image data"
    assert list((tmp_path / "jobs").iterdir()) == []


def test_upload_rejects_empty_image(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    response = upload_job(client, content=b"")

    assert response.status_code == 400
    assert response.json()["detail"] == "Upload must contain supported image data"
    assert list((tmp_path / "jobs").iterdir()) == []


def test_upload_accepts_valid_image_with_generic_content_type(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    response = upload_job(client, content_type="application/octet-stream")

    assert response.status_code == 201
    assert response.json()["status"] == "parsed"


def test_upload_accepts_valid_image_with_uppercase_content_type(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    response = upload_job(client, content_type="IMAGE/PNG")

    assert response.status_code == 201
    assert response.json()["status"] == "parsed"


def test_upload_rejects_oversized_image(tmp_path: Path) -> None:
    client = make_client(tmp_path, max_upload_bytes=len(VALID_PNG) - 1)

    response = upload_job(client)

    assert response.status_code == 413
    assert response.json()["detail"] == "Upload exceeds maximum size"
    assert list((tmp_path / "jobs").iterdir()) == []


def test_parser_configuration_errors_are_http_errors_and_stored(tmp_path: Path) -> None:
    client = make_client(tmp_path, parser_provider="missing")

    response = upload_job(client)

    assert response.status_code == 500
    assert response.json()["detail"] == "Parser configuration error: Unknown parser provider: missing"
    job = load_only_job(tmp_path)
    assert job.status == "error"
    assert job.error == "Unknown parser provider: missing"


def test_parser_runtime_errors_are_bad_gateway_and_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingParser:
        name = "failing"

        def parse(self, image_path: Path):
            raise ParserError("parser exploded")

    monkeypatch.setattr("app.api.build_parser", lambda settings: FailingParser())
    client = make_client(tmp_path)

    response = upload_job(client)

    assert response.status_code == 502
    assert response.json()["detail"] == "parser exploded"
    job = load_only_job(tmp_path)
    assert job.status == "error"
    assert job.error == "parser exploded"


def test_provider_runtime_errors_are_bad_gateway_and_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingProvider:
        name = "failing"
        required_fields = ["hero_cards", "street"]

        def required_fields_for(self, state: object):
            return self.required_fields

        def recommend(self, request: object):
            raise ProviderError("provider exploded")

    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    monkeypatch.setattr("app.api.build_provider", lambda settings: FailingProvider())

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 502
    assert response.json()["detail"] == "provider exploded"
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "error"
    assert job.error == "provider exploded"


def test_recommend_reports_missing_required_fields(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id, {"street": "flop", "user_approved": True})

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert response.json()["detail"] == {"missing_fields": ["hero_cards"]}
    assert FileJobStore(tmp_path).get(job_id).status == "approved"


@pytest.mark.parametrize(
    ("missing_field", "value"),
    [
        ("hero_position", None),
        ("facing_action", None),
        ("hero_stack", None),
    ],
)
def test_cfr_only_recommend_reports_missing_postflop_fields(
    tmp_path: Path, missing_field: str, value: object
) -> None:
    client = make_client(
        tmp_path,
        recommendation_provider="local_solver",
        local_solver_engine="postflop_solver",
        postflop_solver_fallback_enabled=False,
    )
    job_id = upload_job(client).json()["id"]
    state = {**APPROVED_STATE, "players_in_hand": 2, missing_field: value}
    approve_job(client, job_id, state)

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert response.json()["detail"] == {"missing_fields": [missing_field]}
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "approved"
    assert job.error is None


def test_cfr_only_unsupported_state_is_user_correctable(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        recommendation_provider="local_solver",
        local_solver_engine="postflop_solver",
        postflop_solver_fallback_enabled=False,
    )
    job_id = upload_job(client).json()["id"]
    approve_job(
        client,
        job_id,
        {**APPROVED_STATE, "players_in_hand": 2, "facing_action": "raise"},
    )

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert "raises require full action history" in response.json()["detail"]
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "approved"
    assert job.error is None


def test_upload_auto_approves_when_thresholds_are_met(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        parser_auto_approve_enabled=True,
        parser_auto_approve_thresholds={"hero_cards": 0.99, "board_cards": 0.98, "street": 1.0},
    )

    response = upload_job(client)

    assert response.status_code == 201
    job = response.json()
    assert job["status"] == "approved"
    assert job["approved_state"]["user_approved"] is True


def test_upload_stays_parsed_when_auto_approve_threshold_is_not_met(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        parser_auto_approve_enabled=True,
        parser_auto_approve_thresholds={"hero_cards": 1.0},
    )

    response = upload_job(client)

    assert response.status_code == 201
    job = response.json()
    assert job["status"] == "parsed"
    assert job["approved_state"] is None


def test_benchmark_requires_explicitly_approved_ground_truth(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]

    rejected = client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})

    assert rejected.status_code == 409
    assert rejected.json()["detail"] == "Approve corrected state before adding it to the benchmark"
    overview = client.get("/api/benchmarks")
    assert overview.status_code == 200
    assert overview.json() == {
        "included_cases": 0,
        "latest_report": None,
        "recent_reports": [],
    }


def test_benchmark_scores_active_parser_and_persists_latest_report(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    inclusion = client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    report_response = client.post("/api/benchmarks/run")

    assert inclusion.status_code == 200
    assert inclusion.json()["benchmark_included"] is True
    assert report_response.status_code == 200
    report = report_response.json()
    assert report["parser_provider"] == "mock"
    assert report["total_cases"] == 1
    assert report["successful_cases"] == 1
    assert report["failed_cases"] == 0
    assert report["accuracy"] == 1
    assert report["correct_fields"] == report["evaluated_fields"]
    assert {metric["field"] for metric in report["field_metrics"]} == set(APPROVED_STATE) - {
        "user_approved"
    }
    assert FileBenchmarkStore(tmp_path).get_latest().id == report["id"]
    overview = client.get("/api/benchmarks").json()
    assert overview["latest_report"]["id"] == report["id"]
    assert overview["recent_reports"] == [
        {
            "id": report["id"],
            "parser_provider": "mock",
            "layout_profile": "generic",
            "created_at": report["created_at"],
            "total_cases": 1,
            "failed_cases": 0,
            "accuracy": 1.0,
            "field_metrics": report["field_metrics"],
        }
    ]


def test_benchmark_exposes_recent_summaries_and_historical_report_detail(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    first_report = client.post("/api/benchmarks/run").json()
    approve_job(client, job_id, {**APPROVED_STATE, "pot_size": 18.0})
    second_report = client.post("/api/benchmarks/run").json()

    overview = client.get("/api/benchmarks").json()
    historical = client.get(f"/api/benchmarks/{first_report['id']}")
    missing = client.get("/api/benchmarks/not-a-report")

    assert [summary["id"] for summary in overview["recent_reports"]] == [
        second_report["id"],
        first_report["id"],
    ]
    assert all(
        "cases" not in summary and summary["field_metrics"]
        for summary in overview["recent_reports"]
    )
    assert historical.status_code == 200
    assert historical.json() == first_report
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Benchmark report not found"

    stale_report_path = tmp_path / "benchmarks" / f"{'0' * 32}.json"
    stale_report_path.write_text("not valid JSON")
    os.utime(stale_report_path, ns=(0, 0))
    bounded_history = FileBenchmarkStore(tmp_path).list(limit=2)

    assert [report.id for report in bounded_history] == [
        second_report["id"],
        first_report["id"],
    ]


def test_benchmark_uses_corrections_without_mutating_original_parse(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    original_parser_result = FileJobStore(tmp_path).get(job_id).parser_result
    approve_job(client, job_id, {**APPROVED_STATE, "pot_size": 18.0})
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})

    report = client.post("/api/benchmarks/run").json()

    pot_metric = next(metric for metric in report["field_metrics"] if metric["field"] == "pot_size")
    assert pot_metric == {"field": "pot_size", "correct": 0, "total": 1, "accuracy": 0.0}
    assert report["accuracy"] < 1
    assert FileJobStore(tmp_path).get(job_id).parser_result == original_parser_result


def test_benchmark_treats_board_card_order_as_equivalent(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(
        client,
        job_id,
        {**APPROVED_STATE, "board_cards": list(reversed(APPROVED_STATE["board_cards"]))},
    )
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})

    report = client.post("/api/benchmarks/run").json()

    board_metric = next(
        metric for metric in report["field_metrics"] if metric["field"] == "board_cards"
    )
    assert board_metric == {"field": "board_cards", "correct": 1, "total": 1, "accuracy": 1.0}


def test_benchmark_continues_after_an_individual_parser_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_client(tmp_path)
    first_id = upload_job(client, filename="first.png").json()["id"]
    second_id = upload_job(client, filename="second.png").json()["id"]
    for job_id in (first_id, second_id):
        approve_job(client, job_id)
        client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})

    class PartiallyFailingParser:
        name = "partially_failing"

        def parse(self, image_path: Path):
            if image_path.parent.name == second_id:
                raise ParserError("case failed")
            return MockParser().parse(image_path)

    monkeypatch.setattr("app.api.build_parser", lambda settings: PartiallyFailingParser())

    response = client.post("/api/benchmarks/run")

    assert response.status_code == 200
    report = response.json()
    assert report["total_cases"] == 2
    assert report["successful_cases"] == 1
    assert report["failed_cases"] == 1
    failed_case = next(case for case in report["cases"] if case["status"] == "error")
    assert failed_case["job_id"] == second_id
    assert failed_case["error"] == "case failed"
    assert failed_case["evaluated_fields"] > 0


def test_benchmark_continues_after_an_individual_image_path_failure(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    valid_id = upload_job(client, filename="valid.png").json()["id"]
    invalid_id = upload_job(client, filename="invalid.png").json()["id"]
    for job_id in (valid_id, invalid_id):
        approve_job(client, job_id)
        client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})

    store = FileJobStore(tmp_path)
    invalid_job = store.get(invalid_id)
    invalid_job.image_filename = "../outside.png"
    store.save(invalid_job)

    response = client.post("/api/benchmarks/run")

    assert response.status_code == 200
    report = response.json()
    assert report["total_cases"] == 2
    assert report["successful_cases"] == 1
    assert report["failed_cases"] == 1
    failed_case = next(case for case in report["cases"] if case["status"] == "error")
    assert failed_case["job_id"] == invalid_id
    assert "outside.png" in failed_case["error"]


def test_benchmark_parser_configuration_error_does_not_replace_latest_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    previous_report = client.post("/api/benchmarks/run").json()

    class MisconfiguredParser:
        name = "misconfigured"

        def parse(self, image_path: Path):
            raise ParserConfigurationError("external parser URL is missing")

    monkeypatch.setattr("app.api.build_parser", lambda settings: MisconfiguredParser())

    response = client.post("/api/benchmarks/run")

    assert response.status_code == 500
    assert response.json()["detail"] == (
        "Parser configuration error: external parser URL is missing"
    )
    assert FileBenchmarkStore(tmp_path).get_latest().id == previous_report["id"]


def test_provider_configuration_errors_are_http_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MisconfiguredProvider:
        name = "misconfigured"
        required_fields = ["missing_field"]

        def required_fields_for(self, state: object):
            return self.required_fields

    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    monkeypatch.setattr("app.api.build_provider", lambda settings: MisconfiguredProvider())

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 500
    assert response.json()["detail"] == "Provider configuration error: Unknown required field: missing_field"
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "error"
    assert job.error == "Unknown required field: missing_field"


def test_store_persists_jobs_and_rejects_invalid_job_ids(tmp_path: Path) -> None:
    store = FileJobStore(tmp_path)
    job = store.create_job(
        original_filename="table.png",
        image_bytes=VALID_PNG,
        parser_provider="mock",
        recommendation_provider="mock",
    )

    reloaded = FileJobStore(tmp_path).get(job.id)

    assert reloaded.id == job.id
    assert reloaded.image_filename == "original.png"
    for invalid_job_id in ["../job", f"{job.id}/../{job.id}", "." * 32, "g" * 32, "abc"]:
        with pytest.raises(JobNotFoundError):
            store.get(invalid_job_id)


def test_invalid_job_id_returns_not_found(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    response = client.get("/api/jobs/not-a-valid-job-id")

    assert response.status_code == 404
    assert response.json()["detail"] == "Job not found"


def test_missing_job_mutations_do_not_allocate_per_job_locks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_locks = []

    def counting_lock():
        lock = ThreadLock()
        created_locks.append(lock)
        return lock

    monkeypatch.setattr("app.api.Lock", counting_lock)
    client = make_client(tmp_path)
    initial_lock_count = len(created_locks)

    for index in range(20):
        job_id = f"{index:032x}"
        responses = (
            client.post(f"/api/jobs/{job_id}/approve", json=APPROVED_STATE),
            client.put(
                f"/api/jobs/{job_id}/decision",
                json={"action": "call", "sizing": None},
            ),
            client.post(f"/api/jobs/{job_id}/recommend"),
            client.put(f"/api/jobs/{job_id}/benchmark", json={"included": False}),
        )
        assert all(response.status_code == 404 for response in responses)

    assert initial_lock_count > 0
    assert len(created_locks) == initial_lock_count


def test_image_endpoint_rejects_tampered_image_filename(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    store = FileJobStore(tmp_path)
    job = store.get(job_id)
    job.image_filename = "../outside.png"
    store.save(job)

    response = client.get(f"/api/jobs/{job_id}/image")

    assert response.status_code == 404
    with pytest.raises(JobNotFoundError):
        store.image_path(job)


def test_image_endpoint_returns_not_found_when_image_file_is_missing(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    store = FileJobStore(tmp_path)
    job = store.get(job_id)
    store.image_path(job).unlink()

    response = client.get(f"/api/jobs/{job_id}/image")

    assert response.status_code == 404
    assert response.json()["detail"] == "Job image not found"
