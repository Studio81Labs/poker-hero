from pathlib import Path
from threading import Event, Lock as ThreadLock, Thread

import pytest

import app.bootstrap as bootstrap_module
from app.parsers.base import ParserError
from app.parsers.mock import MockParser
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
)


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
