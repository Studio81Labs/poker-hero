import json
from pathlib import Path
from threading import Event, Lock as ThreadLock, Thread

import pytest
from fastapi.testclient import TestClient

import app.bootstrap as bootstrap_module
from app.api import create_app
from app.config import Settings
from app.parsers.base import ParserError
from app.parsers.mock import MockParser
from app.providers.base import ProviderError
from app.providers.mock import MockRecommendationProvider
from app.storage import (
    FileBenchmarkStore,
    FileJobStore,
    JobNotFoundError,
)
from api_test_support import (
    APPROVED_STATE,
    VALID_PNG,
    approve_job,
    load_only_job,
    make_client,
    upload_job,
    upload_job_with_pipeline,
)


def test_upload_parse_approve_and_recommend(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    recommendation_request_id = "recommendation-request-123"

    upload = upload_job(client)

    assert upload.status_code == 201
    job = upload.json()
    assert job["status"] == "parsed"
    assert job["parser_result"]["state"]["hero_cards"][0]["rank"] == "A"
    assert job["parser_result"]["confidences"]["hero_cards"] == 0.99

    approve = approve_job(client, job["id"])

    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    recommend = client.post(
        f"/api/jobs/{job['id']}/recommend",
        headers={"X-Recommendation-Request-ID": recommendation_request_id},
    )

    assert recommend.status_code == 200
    result = recommend.json()
    assert result["status"] == "recommended"
    assert result["recommendation_request_id"] == recommendation_request_id
    assert result["recommendation"]["action"] == "call"
    assert result["recommendation"]["sizing"] is None
    assert (
        FileJobStore(tmp_path).get(job["id"]).recommendation_request_id
        == recommendation_request_id
    )


def test_recommendation_uses_provider_selected_when_job_was_uploaded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selected_settings: list[Settings] = []

    def capture_provider(settings: Settings):
        selected_settings.append(settings)
        return MockRecommendationProvider()

    monkeypatch.setattr(bootstrap_module, "build_provider", capture_provider)
    client = make_client(
        tmp_path,
        recommendation_enabled_providers=["rule_based"],
    )
    upload = upload_job_with_pipeline(
        client,
        parser_provider="mock",
        parser_layout_profile="generic",
        recommendation_provider="rule_based",
    )
    job_id = upload.json()["id"]
    approve_job(client, job_id)

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 200
    assert len(selected_settings) == 1
    assert selected_settings[0].recommendation_provider == "rule_based"


def test_recommendation_does_not_require_a_completed_job_parser_to_remain_enabled(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    store = FileJobStore(tmp_path)
    job = store.get(job_id)
    job.parser_provider = "llm_vision"
    job.parser_layout_profile = "generic"
    store.save(job)
    approve_job(client, job_id)

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 200
    assert response.json()["status"] == "recommended"


def test_recommendation_does_not_require_a_persisted_provider_to_remain_enabled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(
        data_dir=tmp_path,
        parser_provider="mock",
        recommendation_provider="mock",
        recommendation_enabled_providers=["rule_based"],
    )
    client = TestClient(create_app(settings))
    upload = upload_job_with_pipeline(
        client,
        parser_provider="mock",
        parser_layout_profile="generic",
        recommendation_provider="rule_based",
    )
    job_id = upload.json()["id"]
    approve_job(client, job_id)
    settings.recommendation_enabled_providers = []
    monkeypatch.setattr(
        bootstrap_module,
        "build_provider",
        lambda _settings: MockRecommendationProvider(),
    )

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 200
    assert response.json()["status"] == "recommended"


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("pot_size", True),
        ("pot_size", "12.5"),
        ("players_in_hand", True),
        ("players_in_hand", "3"),
        ("players_in_hand", 3.0),
    ],
)
def test_approval_rejects_coerced_numeric_state(
    tmp_path: Path,
    field_name: str,
    value: object,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]

    response = approve_job(
        client,
        job_id,
        {**APPROVED_STATE, field_name: value},
    )

    assert response.status_code == 422
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "parsed"
    assert job.approved_state is None


def test_reapproval_clears_previous_recommendation(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 7.5},
    )
    client.post(f"/api/jobs/{job_id}/recommend")
    review = client.put(
        f"/api/jobs/{job_id}/training-review",
        json={"note": "Review the call price before choosing a raise."},
    )

    assert review.status_code == 200
    assert review.json()["training_reviewed_at"]
    assert review.json()["training_review_note"] == (
        "Review the call price before choosing a raise."
    )

    corrected_state = {**APPROVED_STATE, "pot_size": 18.0}
    response = approve_job(client, job_id, corrected_state)

    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "approved"
    assert job["approved_state"]["pot_size"] == 18.0
    assert job["training_decision"] is None
    assert job["recommendation"] is None
    assert job["training_reviewed_at"] is None
    assert job["training_review_note"] is None
    assert FileJobStore(tmp_path).get(job_id).recommendation is None


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
    imported_job = FileJobStore(tmp_path).get(job_id)
    imported_job.parser_result = None
    imported_job.benchmark_included = True
    FileJobStore(tmp_path).save(imported_job)
    monkeypatch.setattr(
        "app.bootstrap.build_provider",
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
        in_progress_job = client.get(f"/api/jobs/{job_id}")
        assert in_progress_job.status_code == 200
        assert in_progress_job.json()["recommendation_pending"] is True
        processing_jobs = client.get("/api/jobs")
        assert processing_jobs.status_code == 200
        assert processing_jobs.json()["total"] == 1
        assert processing_jobs.json()["jobs"][0]["id"] == job_id
        assert processing_jobs.json()["jobs"][0]["recommendation_pending"] is True
        duplicate_response = client.post(f"/api/jobs/{job_id}/recommend")
        assert duplicate_response.status_code == 409
        assert duplicate_response.json()["detail"] == "Recommendation is already running"
        reapproval_response = approve_job(client, job_id)
        assert reapproval_response.status_code == 409
        assert reapproval_response.json()["detail"] == "Recommendation is already running"
        assert FileJobStore(tmp_path).get(job_id).recommendation_pending is True
        decision_response = client.put(
            f"/api/jobs/{job_id}/decision",
            json={"action": "raise", "sizing": 7.5},
        )
        assert decision_response.status_code == 200
        assert decision_response.json()["recommendation_pending"] is True
    finally:
        release_provider.set()
        recommendation_thread.join(timeout=5)

    assert not recommendation_thread.is_alive()
    assert len(recommendation_responses) == 1
    recommendation_response = recommendation_responses[0]
    assert recommendation_response.status_code == 200
    job = recommendation_response.json()
    assert job["status"] == "recommended"
    assert job["recommendation_pending"] is False
    assert job["training_decision"]["action"] == "raise"
    assert job["training_decision"]["sizing"] == 7.5
    persisted_job = FileJobStore(tmp_path).get(job_id)
    assert persisted_job.training_decision.action == "raise"
    assert persisted_job.recommendation is not None


def test_superseded_recommendation_cannot_overwrite_newer_attempt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_provider_started = Event()
    release_first_provider = Event()
    provider_calls = 0
    provider_calls_lock = ThreadLock()

    class SupersededRecommendationProvider(MockRecommendationProvider):
        def recommend(self, request):
            nonlocal provider_calls
            with provider_calls_lock:
                provider_calls += 1
                call_number = provider_calls
            if call_number == 1:
                first_provider_started.set()
                if not release_first_provider.wait(timeout=5):
                    raise ProviderError("test provider timed out")
            return super().recommend(request)

    provider = SupersededRecommendationProvider()
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    monkeypatch.setattr("app.bootstrap.build_provider", lambda settings: provider)
    first_responses = []
    first_thread = Thread(
        target=lambda: first_responses.append(client.post(
            f"/api/jobs/{job_id}/recommend",
            headers={"X-Recommendation-Request-ID": "first-attempt"},
        ))
    )

    first_thread.start()
    try:
        assert first_provider_started.wait(timeout=2)
        store = FileJobStore(tmp_path)
        recovered_job = store.get(job_id)
        recovered_job.recommendation_pending = False
        recovered_job.status = "error"
        recovered_job.error = "Recommendation was recovered elsewhere"
        store.save(recovered_job)

        newer_response = client.post(
            f"/api/jobs/{job_id}/recommend",
            headers={"X-Recommendation-Request-ID": "newer-attempt"},
        )
        assert newer_response.status_code == 200
        assert newer_response.json()["recommendation_request_id"] == "newer-attempt"
    finally:
        release_first_provider.set()
        first_thread.join(timeout=5)

    assert not first_thread.is_alive()
    assert len(first_responses) == 1
    assert first_responses[0].status_code == 409
    assert first_responses[0].json()["detail"] == (
        "A newer recommendation request replaced this attempt"
    )
    persisted_job = FileJobStore(tmp_path).get(job_id)
    assert persisted_job.recommendation_request_id == "newer-attempt"
    assert persisted_job.recommendation_pending is False
    assert persisted_job.status == "recommended"
    assert persisted_job.recommendation is not None


def test_app_startup_recovers_interrupted_recommendation(tmp_path: Path) -> None:
    initial_client = make_client(tmp_path)
    job_id = upload_job(initial_client).json()["id"]
    approve_job(initial_client, job_id)
    store = FileJobStore(tmp_path)
    interrupted_job = store.get(job_id)
    interrupted_job.recommendation_pending = True
    store.save(interrupted_job)

    restarted_client = make_client(tmp_path)

    recovered_response = restarted_client.get(f"/api/jobs/{job_id}")
    assert recovered_response.status_code == 200
    recovered_job = recovered_response.json()
    assert recovered_job["recommendation_pending"] is False
    assert recovered_job["status"] == "error"
    assert recovered_job["error"] == (
        "Recommendation was interrupted by a backend restart; request it again"
    )

    retry_response = restarted_client.post(f"/api/jobs/{job_id}/recommend")
    assert retry_response.status_code == 200
    assert retry_response.json()["status"] == "recommended"


def test_app_startup_loads_legacy_non_actionable_recommendation_sizing(
    tmp_path: Path,
) -> None:
    initial_client = make_client(tmp_path)
    job_id = upload_job(initial_client).json()["id"]
    approve_job(initial_client, job_id)
    recommendation_response = initial_client.post(f"/api/jobs/{job_id}/recommend")
    assert recommendation_response.status_code == 200
    assert recommendation_response.json()["recommendation"]["action"] == "call"

    record_path = tmp_path / "jobs" / job_id / "job.json"
    legacy_record = json.loads(record_path.read_text())
    legacy_record["recommendation"]["sizing"] = 2.5
    record_path.write_text(json.dumps(legacy_record))

    restarted_client = make_client(tmp_path)

    recovered_response = restarted_client.get(f"/api/jobs/{job_id}")
    assert recovered_response.status_code == 200
    assert recovered_response.json()["recommendation"]["sizing"] is None
    listed_response = restarted_client.get("/api/jobs")
    assert listed_response.status_code == 200
    assert listed_response.json()["jobs"][0]["recommendation"]["sizing"] is None


def test_app_startup_loads_legacy_zero_wager_sizing(tmp_path: Path) -> None:
    initial_client = make_client(tmp_path)
    job_id = upload_job(initial_client).json()["id"]
    approve_job(initial_client, job_id)
    decision_response = initial_client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 7.5},
    )
    assert decision_response.status_code == 200
    recommendation_response = initial_client.post(f"/api/jobs/{job_id}/recommend")
    assert recommendation_response.status_code == 200

    record_path = tmp_path / "jobs" / job_id / "job.json"
    legacy_record = json.loads(record_path.read_text())
    legacy_record["training_decision"]["sizing"] = 0
    legacy_record["recommendation"]["action"] = "raise"
    legacy_record["recommendation"]["sizing"] = 0
    record_path.write_text(json.dumps(legacy_record))

    restarted_client = make_client(tmp_path)

    recovered_response = restarted_client.get(f"/api/jobs/{job_id}")
    assert recovered_response.status_code == 200
    recovered_job = recovered_response.json()
    assert recovered_job["training_decision"]["sizing"] is None
    assert recovered_job["recommendation"]["sizing"] is None


def test_app_startup_recovers_interrupted_parser_job(tmp_path: Path) -> None:
    store = FileJobStore(tmp_path)
    interrupted_job = store.create_job(
        original_filename="interrupted-parser.png",
        image_bytes=VALID_PNG,
        parser_provider="mock",
        recommendation_provider="mock",
    )

    restarted_client = make_client(tmp_path)

    recovered_response = restarted_client.get(f"/api/jobs/{interrupted_job.id}")
    assert recovered_response.status_code == 200
    recovered_job = recovered_response.json()
    assert recovered_job["recommendation_pending"] is False
    assert recovered_job["status"] == "error"
    assert recovered_job["error"] == (
        "Parsing was interrupted by a backend restart; upload the screenshot again"
    )


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


def test_job_read_completes_before_concurrent_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    record_path = tmp_path / "jobs" / job_id / "job.json"
    read_started = Event()
    release_read = Event()
    delete_started = Event()
    delete_finished = Event()
    responses: dict[str, object] = {}
    original_read_bytes = Path.read_bytes
    paused = False

    def pause_record_read(path: Path) -> bytes:
        nonlocal paused
        if path == record_path and not paused:
            paused = True
            read_started.set()
            assert release_read.wait(timeout=5)
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", pause_record_read)

    read_thread = Thread(
        target=lambda: responses.update(read=client.get(f"/api/jobs/{job_id}")),
    )

    def delete_job() -> None:
        delete_started.set()
        responses["delete"] = client.delete(f"/api/jobs/{job_id}")
        delete_finished.set()

    delete_thread = Thread(target=delete_job)
    read_thread.start()
    assert read_started.wait(timeout=2)
    delete_thread.start()
    try:
        assert delete_started.wait(timeout=2)
        assert not delete_finished.wait(timeout=0.1)
    finally:
        release_read.set()
        read_thread.join(timeout=5)
        delete_thread.join(timeout=5)

    assert not read_thread.is_alive()
    assert not delete_thread.is_alive()
    assert responses["read"].status_code == 200
    assert responses["read"].json()["id"] == job_id
    assert responses["delete"].status_code == 204


def test_job_image_read_completes_before_concurrent_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    store = FileJobStore(tmp_path)
    image_path = store.image_path(store.get(job_id))
    read_started = Event()
    release_read = Event()
    delete_started = Event()
    delete_finished = Event()
    responses: dict[str, object] = {}
    original_read_bytes = Path.read_bytes
    paused = False

    def pause_image_read(path: Path) -> bytes:
        nonlocal paused
        if path == image_path and not paused:
            paused = True
            read_started.set()
            assert release_read.wait(timeout=5)
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", pause_image_read)

    read_thread = Thread(
        target=lambda: responses.update(
            read=client.get(f"/api/jobs/{job_id}/image"),
        ),
    )

    def delete_job() -> None:
        delete_started.set()
        responses["delete"] = client.delete(f"/api/jobs/{job_id}")
        delete_finished.set()

    delete_thread = Thread(target=delete_job)
    read_thread.start()
    assert read_started.wait(timeout=2)
    delete_thread.start()
    try:
        assert delete_started.wait(timeout=2)
        assert not delete_finished.wait(timeout=0.1)
    finally:
        release_read.set()
        read_thread.join(timeout=5)
        delete_thread.join(timeout=5)

    assert not read_thread.is_alive()
    assert not delete_thread.is_alive()
    assert responses["read"].status_code == 200
    assert responses["read"].content == VALID_PNG
    assert responses["delete"].status_code == 204


def test_delete_rejects_while_benchmark_import_is_pending(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    FileBenchmarkStore(tmp_path).begin_import(
        "pending-import-before-delete",
        b"pending archive",
    )

    response = client.delete(f"/api/jobs/{job_id}")

    assert response.status_code == 409
    assert response.json()["detail"] == "A benchmark dataset import is still pending"
    assert client.get(f"/api/jobs/{job_id}").status_code == 200
    assert client.get(f"/api/jobs/{job_id}/image").content == VALID_PNG


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


def test_metadata_update_during_active_parser_is_preserved(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parse_started = Event()
    release_parse = Event()
    metadata_started = Event()
    metadata_finished = Event()
    responses: dict[str, object] = {}

    class SlowParser(MockParser):
        def parse(self, image_path: Path):
            parse_started.set()
            assert release_parse.wait(timeout=5)
            return super().parse(image_path)

    monkeypatch.setattr("app.bootstrap.build_parser", lambda settings: SlowParser())
    client = make_client(tmp_path)
    upload_thread = Thread(
        target=lambda: responses.update(upload=upload_job(client)),
    )
    upload_thread.start()
    assert parse_started.wait(timeout=2)
    job_id = FileJobStore(tmp_path).list()[0].id

    def update_metadata() -> None:
        metadata_started.set()
        responses["metadata"] = client.put(
            f"/api/jobs/{job_id}/metadata",
            json={
                "title": "Turn bluff review",
                "notes": "Check the smaller sizing.",
                "tags": ["turn", "bluff"],
            },
        )
        metadata_finished.set()

    metadata_thread = Thread(target=update_metadata)
    metadata_thread.start()
    try:
        assert metadata_started.wait(timeout=2)
        assert metadata_finished.wait(timeout=2)
    finally:
        release_parse.set()
        upload_thread.join(timeout=5)
        metadata_thread.join(timeout=5)

    assert not upload_thread.is_alive()
    assert not metadata_thread.is_alive()
    assert responses["upload"].status_code == 201
    assert responses["metadata"].status_code == 200
    persisted = FileJobStore(tmp_path).get(job_id)
    assert persisted.status == "parsed"
    assert persisted.title == "Turn bluff review"
    assert persisted.notes == "Check the smaller sizing."
    assert persisted.tags == ["turn", "bluff"]


@pytest.mark.parametrize(
    ("complete_recommendation", "expected_status"),
    [(False, "approved"), (True, "recommended")],
)
def test_late_parser_failure_preserves_newer_approved_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    complete_recommendation: bool,
    expected_status: str,
) -> None:
    parse_started = Event()
    release_parse = Event()
    responses: dict[str, object] = {}

    class SlowFailingParser:
        name = "slow_failing"

        def parse(self, image_path: Path):
            parse_started.set()
            assert release_parse.wait(timeout=5)
            raise ParserError("late parser failure")

    monkeypatch.setattr(
        "app.bootstrap.build_parser",
        lambda settings: SlowFailingParser(),
    )
    client = make_client(tmp_path)
    upload_thread = Thread(
        target=lambda: responses.update(upload=upload_job(client)),
    )
    upload_thread.start()
    assert parse_started.wait(timeout=2)
    job_id = FileJobStore(tmp_path).list()[0].id

    try:
        approved = approve_job(client, job_id)
        recommendation = (
            client.post(f"/api/jobs/{job_id}/recommend")
            if complete_recommendation
            else None
        )
        assert approved.status_code == 200
        if recommendation is not None:
            assert recommendation.status_code == 200
    finally:
        release_parse.set()
        upload_thread.join(timeout=5)

    assert not upload_thread.is_alive()
    assert responses["upload"].status_code == 502
    persisted = FileJobStore(tmp_path).get(job_id)
    assert persisted.status == expected_status
    assert persisted.error is None
    assert persisted.approved_state is not None
    assert (persisted.recommendation is not None) is complete_recommendation


def test_delete_during_active_parser_cancels_upload_without_resurrecting_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parse_started = Event()
    release_parse = Event()
    delete_started = Event()
    delete_finished = Event()
    responses: dict[str, object] = {}

    class SlowParser(MockParser):
        def parse(self, image_path: Path):
            parse_started.set()
            assert release_parse.wait(timeout=5)
            return super().parse(image_path)

    monkeypatch.setattr("app.bootstrap.build_parser", lambda settings: SlowParser())
    client = make_client(tmp_path)
    upload_thread = Thread(
        target=lambda: responses.update(upload=upload_job(client)),
    )
    upload_thread.start()
    assert parse_started.wait(timeout=2)
    job_id = FileJobStore(tmp_path).list()[0].id

    def delete_job() -> None:
        delete_started.set()
        responses["delete"] = client.delete(f"/api/jobs/{job_id}")
        delete_finished.set()

    delete_thread = Thread(target=delete_job)
    delete_thread.start()
    try:
        assert delete_started.wait(timeout=2)
        assert delete_finished.wait(timeout=2)
    finally:
        release_parse.set()
        upload_thread.join(timeout=5)
        delete_thread.join(timeout=5)

    assert not upload_thread.is_alive()
    assert not delete_thread.is_alive()
    assert responses["upload"].status_code == 409
    assert responses["upload"].json()["detail"] == (
        "Upload was deleted while parsing"
    )
    assert responses["delete"].status_code == 204
    with pytest.raises(JobNotFoundError):
        FileJobStore(tmp_path).get(job_id)


def test_colliding_job_stripe_does_not_block_unrelated_parser(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_parse_started = Event()
    second_parse_started = Event()
    release_first_parse = Event()
    parse_calls_lock = ThreadLock()
    parse_calls = 0
    responses: dict[str, object] = {}

    class IndependentlySlowParser(MockParser):
        def parse(self, image_path: Path):
            nonlocal parse_calls
            with parse_calls_lock:
                parse_calls += 1
                call_number = parse_calls
            if call_number == 1:
                first_parse_started.set()
                assert release_first_parse.wait(timeout=5)
            else:
                second_parse_started.set()
            return super().parse(image_path)

    monkeypatch.setattr("app.bootstrap.JOB_LOCK_STRIPES", 1)
    monkeypatch.setattr(
        "app.bootstrap.build_parser",
        lambda settings: IndependentlySlowParser(),
    )
    client = make_client(tmp_path)
    first_upload = Thread(
        target=lambda: responses.update(first=upload_job(client)),
    )
    second_upload = Thread(
        target=lambda: responses.update(second=upload_job(client)),
    )
    first_upload.start()
    assert first_parse_started.wait(timeout=2)
    second_upload.start()
    try:
        assert second_parse_started.wait(timeout=2)
    finally:
        release_first_parse.set()
        first_upload.join(timeout=5)
        second_upload.join(timeout=5)

    assert not first_upload.is_alive()
    assert not second_upload.is_alive()
    assert responses["first"].status_code == 201
    assert responses["second"].status_code == 201


def test_delete_before_parser_lock_cancels_upload_without_resurrecting_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_created = Event()
    release_create = Event()
    created_job_ids: list[str] = []
    responses: dict[str, object] = {}
    original_create_job = FileJobStore.create_job

    def paused_create_job(store: FileJobStore, *args: object, **kwargs: object):
        job = original_create_job(store, *args, **kwargs)
        created_job_ids.append(job.id)
        job_created.set()
        assert release_create.wait(timeout=5)
        return job

    monkeypatch.setattr(FileJobStore, "create_job", paused_create_job)
    client = make_client(tmp_path)
    upload_thread = Thread(
        target=lambda: responses.update(upload=upload_job(client)),
    )
    upload_thread.start()
    try:
        assert job_created.wait(timeout=2)
        job_id = created_job_ids[0]
        delete_response = client.delete(f"/api/jobs/{job_id}")
    finally:
        release_create.set()
        upload_thread.join(timeout=5)

    assert not upload_thread.is_alive()
    assert delete_response.status_code == 204
    assert responses["upload"].status_code == 409
    assert responses["upload"].json()["detail"] == (
        "Upload was deleted before parsing started"
    )
    with pytest.raises(JobNotFoundError):
        FileJobStore(tmp_path).get(job_id)


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


def test_provider_configuration_errors_are_http_errors_and_stored(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path, recommendation_provider="missing")
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 500
    assert response.json()["detail"] == (
        "Provider configuration error: Unknown recommendation provider: missing"
    )
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "error"
    assert job.error == "Unknown recommendation provider: missing"
    assert job.recommendation_pending is False


def test_parser_runtime_errors_are_bad_gateway_and_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingParser:
        name = "failing"

        def parse(self, image_path: Path):
            raise ParserError("parser exploded")

    monkeypatch.setattr("app.bootstrap.build_parser", lambda settings: FailingParser())
    client = make_client(tmp_path)

    response = upload_job(client)

    assert response.status_code == 502
    assert response.json()["detail"] == "parser exploded"
    job = load_only_job(tmp_path)
    assert job.status == "error"
    assert job.error == "parser exploded"


def test_unexpected_parser_errors_are_http_errors_and_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingParser:
        name = "failing"

        def parse(self, image_path: Path):
            raise RuntimeError("unexpected parser crash")

    monkeypatch.setattr("app.bootstrap.build_parser", lambda settings: FailingParser())
    client = make_client(tmp_path)

    response = upload_job(client)

    assert response.status_code == 500
    assert response.json()["detail"] == (
        "Unexpected parser error: unexpected parser crash"
    )
    job = load_only_job(tmp_path)
    assert job.status == "error"
    assert job.error == "Unexpected parser error: unexpected parser crash"


def test_provider_runtime_errors_are_stored_retryable_and_not_archived(
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
    monkeypatch.setattr("app.bootstrap.build_provider", lambda settings: FailingProvider())

    response = client.post(f"/api/jobs/{job_id}/recommend")
    rejected_archive = client.put(
        "/api/history",
        json={"job_ids": [job_id]},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "provider exploded"
    assert rejected_archive.status_code == 409
    assert rejected_archive.json()["detail"] == (
        "Only successful approved or recommended jobs can be moved to history"
    )
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "error"
    assert job.error == "provider exploded"
    assert job.recommendation_pending is False
    assert job.archived_at is None
    queue = client.get("/api/jobs").json()
    assert [queued_job["id"] for queued_job in queue["jobs"]] == [job_id]


@pytest.mark.parametrize(
    "failure_stage",
    ["build_provider", "required_fields", "validation"],
)
def test_unexpected_provider_setup_errors_clear_pending(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_stage: str,
) -> None:
    class SetupProvider(MockRecommendationProvider):
        def required_fields_for(self, state):
            if failure_stage == "required_fields":
                raise RuntimeError("required fields exploded")
            return super().required_fields_for(state)

    def build_setup_provider(settings):
        if failure_stage == "build_provider":
            raise RuntimeError("provider construction exploded")
        return SetupProvider()

    def fail_required_field_validation(state, required_fields):
        raise RuntimeError("required field validation exploded")

    monkeypatch.setattr("app.bootstrap.build_provider", build_setup_provider)
    if failure_stage == "validation":
        monkeypatch.setattr(
            "app.bootstrap.missing_required_fields",
            fail_required_field_validation,
        )
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    with pytest.raises(RuntimeError, match="exploded"):
        client.post(f"/api/jobs/{job_id}/recommend")

    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "error"
    assert job.error is not None
    assert job.error.startswith("Unexpected provider error:")
    assert job.recommendation_pending is False


def test_recommend_reports_missing_required_fields(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id, {"street": "flop", "user_approved": True})

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert response.json()["detail"] == {"missing_fields": ["hero_cards"]}
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "approved"
    assert job.recommendation_pending is False


def test_multiway_ev_recommendation_requires_committed_opponent_count(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        recommendation_provider="local_solver",
    )
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "missing_fields": ["opponents_at_current_bet"]
    }
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "approved"
    assert job.error is None
    assert job.recommendation_pending is False


def test_local_ev_requires_total_opponent_wager_when_not_derivable(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        recommendation_provider="local_solver",
        local_solver_engine="local_ev",
    )
    job_id = upload_job(client).json()["id"]
    approve_job(
        client,
        job_id,
        {
            "hero_cards": [
                {"rank": "A", "suit": "hearts"},
                {"rank": "K", "suit": "diamonds"},
            ],
            "board_cards": [],
            "pot_size": 4,
            "current_bet": 1.5,
            "hero_stack": 99,
            "effective_stack": 99,
            "players_in_hand": 2,
            "hero_position": "big_blind",
            "street": "preflop",
            "facing_action": "raise",
            "action_context": "",
            "user_approved": True,
        },
    )

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert response.json()["detail"] == {"missing_fields": ["opponent_wager"]}
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "approved"
    assert job.error is None
    assert job.recommendation_pending is False


def test_local_ev_requires_aggregate_multiway_commitments(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        recommendation_provider="local_solver",
        local_solver_engine="local_ev",
    )
    job_id = upload_job(client).json()["id"]
    approve_job(
        client,
        job_id,
        {
            **APPROVED_STATE,
            "pot_size": 30,
            "current_bet": 15,
            "effective_stack": 85,
            "opponents_at_current_bet": 1,
            "opponent_wager": 15,
            "facing_action": "raise",
        },
    )

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "missing_fields": ["opponent_commitment_total"]
    }
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "approved"
    assert job.error is None
    assert job.recommendation_pending is False


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
    assert response.json()["detail"] == {
        "missing_fields": ["opponent_stack", "postflop_action_history"]
    }
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
    assert job["parser_auto_approval_eligible"] is True
    assert job["approved_state"]["user_approved"] is True


def test_upload_reports_threshold_eligibility_when_auto_approval_is_disabled(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        parser_auto_approve_enabled=False,
        parser_auto_approve_thresholds={
            "hero_cards": 0.99,
            "board_cards": 0.98,
            "street": 1.0,
        },
    )

    response = upload_job(client)

    assert response.status_code == 201
    job = response.json()
    assert job["status"] == "parsed"
    assert job["parser_auto_approval_eligible"] is True
    assert job["approved_state"] is None


def test_upload_server_auto_approval_stops_on_parser_warning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class WarningParser(MockParser):
        def parse(self, image_path: Path):
            result = super().parse(image_path)
            result.warnings = ["Hero cards need manual review"]
            return result

    monkeypatch.setattr(bootstrap_module, "build_parser", lambda _settings: WarningParser())
    client = make_client(
        tmp_path,
        parser_auto_approve_enabled=True,
        parser_auto_approve_thresholds={
            "hero_cards": 0.99,
            "board_cards": 0.98,
            "street": 1.0,
        },
    )

    response = upload_job(client)

    assert response.status_code == 201
    job = response.json()
    assert job["status"] == "parsed"
    assert job["parser_auto_approval_eligible"] is True
    assert job["parser_result"]["warnings"] == [
        "Hero cards need manual review"
    ]
    assert job["approved_state"] is None


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
    assert job["parser_auto_approval_eligible"] is False
    assert job["approved_state"] is None


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
    monkeypatch.setattr("app.bootstrap.build_provider", lambda settings: MisconfiguredProvider())

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 500
    assert response.json()["detail"] == "Provider configuration error: Unknown required field: missing_field"
    job = FileJobStore(tmp_path).get(job_id)
    assert job.status == "error"
    assert job.error == "Unknown required field: missing_field"
    assert job.recommendation_pending is False


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

    monkeypatch.setattr("app.bootstrap.Lock", counting_lock)
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
