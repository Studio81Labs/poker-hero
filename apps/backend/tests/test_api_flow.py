import base64
import json
import os
from io import BytesIO
from pathlib import Path
from threading import Event, Lock as ThreadLock, Thread
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from app import api as api_module
from app import dataset_export as dataset_export_module
from app import dataset_import as dataset_import_module
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
    review = client.put(f"/api/jobs/{job_id}/training-review")

    assert review.status_code == 200
    assert review.json()["training_reviewed_at"]

    corrected_state = {**APPROVED_STATE, "pot_size": 18.0}
    response = approve_job(client, job_id, corrected_state)

    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "approved"
    assert job["approved_state"]["pot_size"] == 18.0
    assert job["training_decision"] is None
    assert job["recommendation"] is None
    assert job["training_reviewed_at"] is None
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
    assert progress["needs_review_hands"] == 0
    assert progress["action_accuracy"] == 1
    assert progress["exact_accuracy"] == 1
    assert progress["ev_compared_hands"] == 0
    assert progress["average_ev_loss_bb"] is None
    assert progress["street_summaries"][0]["street"] == "flop"
    assert progress["street_summaries"][0]["ev_compared_hands"] == 0
    assert progress["street_summaries"][0]["average_ev_loss_bb"] is None
    assert progress["recent_hands"][0]["job_id"] == job_id
    assert progress["recent_hands"][0]["outcome"] == "match"
    assert progress["recent_hands"][0]["ev_loss_bb"] is None
    assert progress["review_street_counts"] == {}
    assert progress["review_queue_hands"] == 0
    assert progress["review_queue"] == []


def test_training_progress_validates_review_filters(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    filtered = client.get(
        "/api/training/progress?review_order=ev_loss&review_street=flop"
    )
    invalid_order = client.get("/api/training/progress?review_order=unknown")
    invalid_street = client.get("/api/training/progress?review_street=showdown")

    assert filtered.status_code == 200
    assert invalid_order.status_code == 422
    assert invalid_street.status_code == 422


def test_completed_training_review_leaves_accuracy_and_clears_pending_queue(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 7.5},
    )
    client.post(f"/api/jobs/{job_id}/recommend")

    before_review = client.get("/api/training/progress").json()
    response = client.put(f"/api/jobs/{job_id}/training-review")
    repeated = client.put(f"/api/jobs/{job_id}/training-review")
    after_review = client.get("/api/training/progress").json()
    reopened = client.delete(f"/api/jobs/{job_id}/training-review")
    repeated_reopen = client.delete(f"/api/jobs/{job_id}/training-review")
    after_reopen = client.get("/api/training/progress").json()

    assert before_review["needs_review_hands"] == 1
    assert before_review["review_queue"][0]["job_id"] == job_id
    assert response.status_code == 200
    assert response.json()["training_reviewed_at"]
    assert repeated.status_code == 200
    assert repeated.json()["training_reviewed_at"] == response.json()["training_reviewed_at"]
    assert after_review["reviewed_hands"] == 1
    assert after_review["different_actions"] == 1
    assert after_review["needs_review_hands"] == 0
    assert after_review["review_queue"] == []
    assert after_review["recent_hands"][0]["reviewed_at"] == response.json()["training_reviewed_at"]
    assert reopened.status_code == 200
    assert reopened.json()["training_reviewed_at"] is None
    assert repeated_reopen.status_code == 200
    assert repeated_reopen.json()["training_reviewed_at"] is None
    assert after_reopen["reviewed_hands"] == 1
    assert after_reopen["different_actions"] == 1
    assert after_reopen["needs_review_hands"] == 1
    assert after_reopen["review_queue"][0]["job_id"] == job_id
    assert after_reopen["recent_hands"][0]["reviewed_at"] is None
    assert FileJobStore(tmp_path).get(job_id).training_reviewed_at is None


def test_training_review_requires_a_non_exact_comparison(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]

    incomplete = client.put(f"/api/jobs/{job_id}/training-review")
    incomplete_reopen = client.delete(f"/api/jobs/{job_id}/training-review")

    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": None},
    )
    client.post(f"/api/jobs/{job_id}/recommend")
    exact = client.put(f"/api/jobs/{job_id}/training-review")
    exact_reopen = client.delete(f"/api/jobs/{job_id}/training-review")

    assert incomplete.status_code == 409
    assert incomplete.json()["detail"] == (
        "A completed decision comparison is required before review"
    )
    assert incomplete_reopen.status_code == 409
    assert incomplete_reopen.json()["detail"] == (
        "A completed decision comparison is required before reopening review"
    )
    assert exact.status_code == 409
    assert exact.json()["detail"] == "Exact matches do not need review"
    assert exact_reopen.status_code == 409
    assert exact_reopen.json()["detail"] == "Exact matches do not need review"


def test_training_review_rejects_supported_mixed_line(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 8},
    )
    client.post(f"/api/jobs/{job_id}/recommend")

    store = FileJobStore(tmp_path)
    job = store.get(job_id)
    assert job.recommendation is not None
    job.recommendation.raw["candidates"] = [
        {"action": "call", "sizing": None, "frequency": 0.8},
        {"action": "raise", "sizing": 8, "frequency": 0.2},
    ]
    store.save(job)

    complete = client.put(f"/api/jobs/{job_id}/training-review")
    reopen = client.delete(f"/api/jobs/{job_id}/training-review")
    progress = client.get("/api/training/progress").json()

    assert complete.status_code == 409
    assert complete.json()["detail"] == "Exact matches do not need review"
    assert reopen.status_code == 409
    assert reopen.json()["detail"] == "Exact matches do not need review"
    assert store.get(job_id).training_reviewed_at is None
    assert progress["recent_hands"][0]["outcome"] == "mixed"
    assert progress["recent_hands"][0]["reviewed_at"] is None
    assert progress["review_queue"] == []


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
    export = client.get("/api/benchmarks/export")
    assert export.status_code == 409
    assert export.json()["detail"] == "Add at least one approved hand to the benchmark"


def test_benchmark_exports_selected_images_and_approved_labels(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        parser_provider="mock",
        parser_layout_profile="fortuna",
    )
    included_id = upload_job(client, filename="included.png").json()["id"]
    excluded_id = upload_job(client, filename="excluded.png").json()["id"]
    corrected_state = {**APPROVED_STATE, "pot_size": 18.0}
    approve_job(client, included_id, corrected_state)
    approve_job(client, excluded_id)
    client.put(f"/api/jobs/{included_id}/benchmark", json={"included": True})

    response = client.get("/api/benchmarks/export")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].startswith(
        'attachment; filename="poker-hero-parser-dataset-'
    )
    with ZipFile(BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == {
            "manifest.json",
            f"images/{included_id}.png",
        }
        manifest = json.loads(archive.read("manifest.json"))
        assert archive.read(f"images/{included_id}.png") == VALID_PNG

    assert manifest["schema"] == "poker-hero-parser-dataset"
    assert manifest["schema_version"] == 1
    assert manifest["parser_provider"] == "mock"
    assert manifest["layout_profile"] == "fortuna"
    assert manifest["case_count"] == 1
    assert manifest["cases"] == [
        {
            "job_id": included_id,
            "original_filename": "included.png",
            "image_file": f"images/{included_id}.png",
            "expected_state": {
                key: value
                for key, value in corrected_state.items()
                if key != "user_approved"
            },
        }
    ]
    assert all(case["job_id"] != excluded_id for case in manifest["cases"])


def test_benchmark_case_limit_applies_to_selection_and_export(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    first_id = upload_job(client, filename="first.png").json()["id"]
    second_id = upload_job(client, filename="second.png").json()["id"]
    approve_job(client, first_id)
    approve_job(client, second_id)
    monkeypatch.setattr(api_module, "MAX_DATASET_CASES", 1)

    first = client.put(f"/api/jobs/{first_id}/benchmark", json={"included": True})
    rejected = client.put(
        f"/api/jobs/{second_id}/benchmark",
        json={"included": True},
    )

    assert first.status_code == 200
    assert rejected.status_code == 409
    assert rejected.json()["detail"] == "Parser datasets support at most 1 case"

    store = FileJobStore(tmp_path)
    second = store.get(second_id)
    second.benchmark_included = True
    store.save(second)
    monkeypatch.setattr(dataset_export_module, "MAX_DATASET_CASES", 1)

    export = client.get("/api/benchmarks/export")

    assert export.status_code == 409
    assert export.json()["detail"] == "Parser datasets support at most 1 case"


def test_benchmark_archive_limit_applies_to_selection_and_export(tmp_path: Path) -> None:
    archive_limit = 8_000
    client = make_client(tmp_path, max_dataset_upload_bytes=archive_limit)
    job_id = upload_job(client, content=VALID_PNG + os.urandom(9_000)).json()["id"]
    approve_job(client, job_id)

    selection = client.put(
        f"/api/jobs/{job_id}/benchmark",
        json={"included": True},
    )

    assert selection.status_code == 409
    assert selection.json()["detail"] == (
        f"Parser dataset exceeds the configured {archive_limit}-byte archive limit"
    )
    store = FileJobStore(tmp_path)
    job = store.get(job_id)
    assert job.benchmark_included is False

    job.benchmark_included = True
    store.save(job)
    export = client.get("/api/benchmarks/export")

    assert export.status_code == 409
    assert export.json()["detail"] == selection.json()["detail"]


def test_benchmark_export_reports_missing_source_image(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="missing.png").json()["id"]
    approve_job(client, job_id)
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    store = FileJobStore(tmp_path)
    store.image_path(store.get(job_id)).unlink()

    response = client.get("/api/benchmarks/export")

    assert response.status_code == 409
    assert response.json()["detail"] == "Image is unavailable for missing.png"


def test_benchmark_dataset_import_round_trips_and_reuses_existing_cases(
    tmp_path: Path,
) -> None:
    source_client = make_client(tmp_path / "source", parser_layout_profile="fortuna")
    source_job_id = upload_job(source_client, filename="labeled.tmp").json()["id"]
    corrected_state = {**APPROVED_STATE, "pot_size": 18.0}
    approve_job(source_client, source_job_id, corrected_state)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    target_dir = tmp_path / "target"
    target_client = make_client(target_dir)

    imported = target_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )
    repeated = target_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )

    assert imported.status_code == 200
    assert imported.json() == {
        "imported_cases": 1,
        "reused_cases": 0,
        "included_cases": 1,
        "job_ids": [source_job_id],
    }
    assert repeated.status_code == 200
    assert repeated.json() == {
        "imported_cases": 0,
        "reused_cases": 1,
        "included_cases": 1,
        "job_ids": [source_job_id],
    }
    imported_job = FileJobStore(target_dir).get(source_job_id)
    assert imported_job.original_filename == "labeled.tmp"
    assert imported_job.approved_state is not None
    assert imported_job.approved_state.model_dump(mode="json", exclude_none=True) == corrected_state
    assert imported_job.benchmark_included is True
    assert imported_job.status == "approved"
    assert imported_job.parser_result is None
    assert imported_job.recommendation is None
    assert imported_job.training_decision is None
    assert FileJobStore(target_dir).image_path(imported_job).read_bytes() == VALID_PNG


def test_benchmark_dataset_import_rejects_conflicts_without_overwriting(
    tmp_path: Path,
) -> None:
    source_client = make_client(tmp_path / "source")
    job_id = upload_job(source_client, filename="conflict.png").json()["id"]
    approve_job(source_client, job_id)
    source_client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    archive = source_client.get("/api/benchmarks/export").content
    target_dir = tmp_path / "target"
    target_client = make_client(target_dir)
    target_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )
    changed_state = {**APPROVED_STATE, "pot_size": 20.0}
    approve_job(target_client, job_id, changed_state)

    response = target_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == (
        f"Imported case {job_id} conflicts with an existing job"
    )
    existing = FileJobStore(target_dir).get(job_id)
    assert existing.approved_state is not None
    assert existing.approved_state.pot_size == 20


def test_benchmark_dataset_import_enforces_resulting_corpus_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client, filename="source.png").json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content

    target_client = make_client(tmp_path / "target")
    target_job_id = upload_job(target_client, filename="target.png").json()["id"]
    approve_job(target_client, target_job_id)
    target_client.put(
        f"/api/jobs/{target_job_id}/benchmark",
        json={"included": True},
    )
    monkeypatch.setattr(dataset_import_module, "MAX_DATASET_CASES", 1)

    response = target_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Parser datasets support at most 1 case"
    assert FileJobStore(tmp_path / "target").get(target_job_id).benchmark_included is True


def test_benchmark_dataset_import_serializes_reuse_with_corrections(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="concurrent.png").json()["id"]
    approve_job(client, job_id)
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    archive = client.get("/api/benchmarks/export").content
    client.put(f"/api/jobs/{job_id}/benchmark", json={"included": False})

    import_entered = Event()
    release_import = Event()
    approval_started = Event()
    approval_finished = Event()
    responses: dict[str, object] = {}
    original_import = api_module.import_parser_dataset

    def paused_import(*args: object, **kwargs: object):
        import_entered.set()
        assert release_import.wait(timeout=2)
        return original_import(*args, **kwargs)

    monkeypatch.setattr(api_module, "import_parser_dataset", paused_import)

    def run_import() -> None:
        responses["import"] = client.post(
            "/api/benchmarks/import",
            files={"file": ("dataset.zip", archive, "application/zip")},
        )

    corrected_state = {**APPROVED_STATE, "pot_size": 21.0}

    def run_approval() -> None:
        approval_started.set()
        responses["approval"] = approve_job(client, job_id, corrected_state)
        approval_finished.set()

    import_thread = Thread(target=run_import)
    import_thread.start()
    assert import_entered.wait(timeout=2)

    approval_thread = Thread(target=run_approval)
    approval_thread.start()
    assert approval_started.wait(timeout=2)
    assert not approval_finished.wait(timeout=0.1)

    release_import.set()
    import_thread.join(timeout=2)
    approval_thread.join(timeout=2)

    assert not import_thread.is_alive()
    assert not approval_thread.is_alive()
    assert responses["import"].status_code == 200
    assert responses["approval"].status_code == 200
    current = FileJobStore(tmp_path).get(job_id)
    assert current.approved_state is not None
    assert current.approved_state.pot_size == 21
    assert current.benchmark_included is True


def test_benchmark_dataset_import_rejects_invalid_and_oversized_archives(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path / "invalid")
    invalid = client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", b"not a zip", "application/zip")},
    )

    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "Upload must be a valid dataset ZIP"

    source_client = make_client(tmp_path / "source")
    job_id = upload_job(source_client).json()["id"]
    approve_job(source_client, job_id)
    source_client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    archive = source_client.get("/api/benchmarks/export").content
    limited_client = make_client(
        tmp_path / "limited",
        max_dataset_upload_bytes=len(archive) - 1,
    )

    oversized = limited_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )

    assert oversized.status_code == 413
    assert oversized.json()["detail"] == "Dataset ZIP exceeds maximum size"


def test_benchmark_dataset_import_rejects_a_combined_corpus_over_archive_limit(
    tmp_path: Path,
) -> None:
    source_client = make_client(tmp_path / "source")
    imported_id = upload_job(
        source_client,
        content=VALID_PNG + os.urandom(9_000),
        filename="imported.png",
    ).json()["id"]
    approve_job(source_client, imported_id)
    source_client.put(
        f"/api/jobs/{imported_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    archive_limit = len(archive) * 3 // 2

    target_dir = tmp_path / "target"
    target_client = make_client(
        target_dir,
        max_dataset_upload_bytes=archive_limit,
    )
    existing_id = upload_job(
        target_client,
        content=VALID_PNG + os.urandom(9_000),
        filename="existing.png",
    ).json()["id"]
    approve_job(target_client, existing_id)
    inclusion = target_client.put(
        f"/api/jobs/{existing_id}/benchmark",
        json={"included": True},
    )
    assert inclusion.status_code == 200

    imported = target_client.post(
        "/api/benchmarks/import",
        files={"file": ("dataset.zip", archive, "application/zip")},
    )

    assert imported.status_code == 409
    assert imported.json()["detail"] == (
        f"Parser dataset exceeds the configured {archive_limit}-byte archive limit"
    )
    target_store = FileJobStore(target_dir)
    assert target_store.get(existing_id).benchmark_included is True
    with pytest.raises(JobNotFoundError):
        target_store.get(imported_id)


def test_benchmark_dataset_import_rejects_unsafe_image_paths(tmp_path: Path) -> None:
    source_client = make_client(tmp_path / "source")
    job_id = upload_job(source_client).json()["id"]
    approve_job(source_client, job_id)
    source_client.put(f"/api/jobs/{job_id}/benchmark", json={"included": True})
    exported = source_client.get("/api/benchmarks/export").content
    with ZipFile(BytesIO(exported)) as source_archive:
        manifest = json.loads(source_archive.read("manifest.json"))
        image_name = manifest["cases"][0]["image_file"]
        image_bytes = source_archive.read(image_name)
    manifest["cases"][0]["image_file"] = f"../{job_id}.png"
    unsafe_buffer = BytesIO()
    with ZipFile(unsafe_buffer, mode="w") as unsafe_archive:
        unsafe_archive.writestr("manifest.json", json.dumps(manifest))
        unsafe_archive.writestr(f"../{job_id}.png", image_bytes)

    response = make_client(tmp_path / "target").post(
        "/api/benchmarks/import",
        files={
            "file": (
                "dataset.zip",
                unsafe_buffer.getvalue(),
                "application/zip",
            )
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Dataset image path is invalid for table.png"


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
