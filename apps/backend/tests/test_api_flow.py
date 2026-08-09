import asyncio
import base64
import json
import logging
import os
import re
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from threading import Event, Lock as ThreadLock, Thread
from zipfile import ZipFile

import pytest
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import api as api_module
from app import dataset_export as dataset_export_module
from app import dataset_import as dataset_import_module
from app.api import create_app
from app.config import Settings
from app.parsers.base import ParserConfigurationError, ParserError
from app.parsers.mock import MockParser
from app.providers.base import ProviderError, ProviderInputError
from app.providers.mock import MockRecommendationProvider
from app.storage import (
    BenchmarkImportNotFoundError,
    FileBenchmarkStore,
    FileJobStore,
    JobNotFoundError,
)


VALID_PNG = (
    base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
        "AAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="
    )
)
CORS_EXPOSED_HEADERS = (
    "X-Request-ID, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining"
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


@pytest.fixture
def access_log_records(
    monkeypatch: pytest.MonkeyPatch,
) -> list[logging.LogRecord]:
    records: list[logging.LogRecord] = []

    class RecordHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    monkeypatch.setattr(api_module.LOGGER, "handlers", [RecordHandler()])
    monkeypatch.setattr(api_module.LOGGER, "propagate", False)
    return records


def upload_job(
    client: TestClient,
    content: bytes = VALID_PNG,
    content_type: str = "image/png",
    filename: str = "table.png",
    upload_request_id: str | None = None,
):
    data = (
        {"upload_request_id": upload_request_id}
        if upload_request_id is not None
        else None
    )
    return client.post(
        "/api/jobs",
        files={"file": (filename, content, content_type)},
        data=data,
    )


def upload_job_with_pipeline(
    client: TestClient,
    *,
    parser_provider: str,
    parser_layout_profile: str,
    recommendation_provider: str,
    recommendation_engine: str | None = None,
):
    data = {
        "parser_provider": parser_provider,
        "parser_layout_profile": parser_layout_profile,
        "recommendation_provider": recommendation_provider,
    }
    if recommendation_engine is not None:
        data["recommendation_engine"] = recommendation_engine
    return client.post(
        "/api/jobs",
        files={"file": ("table.png", VALID_PNG, "image/png")},
        data=data,
    )


def approve_job(client: TestClient, job_id: str, state: dict[str, object] | None = None):
    return client.post(f"/api/jobs/{job_id}/approve", json=state or APPROVED_STATE)


def load_only_job(tmp_path: Path):
    job_dirs = list((tmp_path / "jobs").iterdir())
    assert len(job_dirs) == 1
    return FileJobStore(tmp_path).get(job_dirs[0].name)


def archive_with_unsupported_compression(archive_bytes: bytes) -> bytes:
    payload = bytearray(archive_bytes)
    for signature, compression_offset in (
        (b"PK\x03\x04", 8),
        (b"PK\x01\x02", 10),
    ):
        header_offset = payload.find(signature)
        assert header_offset >= 0
        payload[
            header_offset + compression_offset:
            header_offset + compression_offset + 2
        ] = (99).to_bytes(2, "little")
    return bytes(payload)


def rebuild_zip_archive(
    archive_bytes: bytes,
    replacements: dict[str, bytes],
) -> bytes:
    output = BytesIO()
    with ZipFile(BytesIO(archive_bytes)) as source:
        with ZipFile(output, "w") as target:
            for info in source.infolist():
                target.writestr(
                    info,
                    replacements.get(info.filename, source.read(info)),
                )
    return output.getvalue()


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
        "environment": "local",
        "parser_provider": "mock",
        "recommendation_provider": "local_solver",
        "recommendation_engine": "postflop_solver",
    }


def test_pipeline_endpoint_reports_runtime_choices(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        parser_layout_profile="generic",
        parser_enabled_layout_profiles=["fortuna_nations"],
        recommendation_enabled_providers=["rule_based"],
    )

    response = client.get("/api/pipeline")

    assert response.status_code == 200
    payload = response.json()
    assert payload["defaults"] == {
        "parser_provider": "mock",
        "parser_layout_profile": "generic",
        "recommendation_provider": "mock",
        "recommendation_engine": None,
    }
    assert [option["id"] for option in payload["parser_layout_profiles"]] == [
        "generic",
        "fortuna_nations",
    ]
    assert payload["parser_layout_compatibility"] == {
        "mock": ["generic", "fortuna_nations"],
    }
    assert [option["id"] for option in payload["recommendation_providers"]] == [
        "mock",
        "rule_based",
    ]


def test_pipeline_endpoint_reports_fallbacks_for_unavailable_defaults(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        parser_provider="llm_vision",
        parser_enabled_providers=["mock"],
        recommendation_provider="external_solver",
        recommendation_enabled_providers=["rule_based"],
    )

    response = client.get("/api/pipeline")

    assert response.status_code == 200
    payload = response.json()
    assert payload["parser_providers"][0] == {
        "id": "llm_vision",
        "label": "External vision",
        "available": False,
        "unavailable_reason": "External parser URL is not configured",
    }
    assert payload["parser_providers"][1]["id"] == "mock"
    assert payload["parser_providers"][1]["available"] is True
    assert payload["recommendation_providers"][0] == {
        "id": "external_solver",
        "label": "External solver",
        "available": False,
        "unavailable_reason": "External solver URL is not configured",
    }
    assert payload["recommendation_providers"][1]["id"] == "rule_based"
    assert payload["recommendation_providers"][1]["available"] is True


def test_upload_persists_explicit_pipeline_selection(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        parser_enabled_layout_profiles=["pokerstars"],
        recommendation_enabled_providers=["rule_based"],
    )

    response = upload_job_with_pipeline(
        client,
        parser_provider="mock",
        parser_layout_profile="pokerstars",
        recommendation_provider="rule_based",
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["parser_provider"] == "mock"
    assert payload["parser_layout_profile"] == "pokerstars"
    assert payload["recommendation_provider"] == "rule_based"
    assert payload["recommendation_engine"] is None


def test_upload_rejects_pipeline_plugin_not_enabled_by_deployment(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)

    response = upload_job_with_pipeline(
        client,
        parser_provider="ocr_cv",
        parser_layout_profile="generic",
        recommendation_provider="mock",
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Parser provider 'ocr_cv' is not enabled for this deployment"
    )
    assert list((tmp_path / "jobs").iterdir()) == []


def test_upload_rejects_layout_not_supported_by_selected_parser(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        parser_enabled_providers=["ocr_cv"],
        parser_enabled_layout_profiles=["pokerstars"],
    )

    response = upload_job_with_pipeline(
        client,
        parser_provider="ocr_cv",
        parser_layout_profile="pokerstars",
        recommendation_provider="mock",
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Layout profile 'pokerstars' is not supported by parser provider 'ocr_cv'"
    )
    assert list((tmp_path / "jobs").iterdir()) == []


def test_default_access_log_level_suppresses_health_event(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    response = make_client(tmp_path).get("/api/health")

    assert response.status_code == 200
    assert access_log_records == []


def test_debug_access_log_level_emits_health_event(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    client = make_client(tmp_path, access_log_level="debug")

    response = client.get(
        "/api/health",
        headers={"X-Request-ID": "health-request-123"},
    )

    assert response.status_code == 200
    access_events = [
        json.loads(record.message)
        for record in access_log_records
        if record.name == "poker.access"
    ]
    assert access_events == [
        {
            "duration_ms": access_events[0]["duration_ms"],
            "event": "http_request",
            "level": "debug",
            "method": "GET",
            "outcome": "completed",
            "path": "/api/health",
            "request_id": "health-request-123",
            "status_code": 200,
        }
    ]
    assert access_log_records[0].levelno == logging.DEBUG


def test_request_id_is_returned_and_access_log_is_structured(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    client = make_client(tmp_path)

    response = client.get(
        "/api/jobs?limit=1",
        headers={"X-Request-ID": "worker-request-123"},
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "worker-request-123"
    messages = [
        json.loads(record.message)
        for record in access_log_records
        if record.name == "poker.access"
    ]
    assert len(messages) == 1
    assert messages == [
        {
            "duration_ms": messages[0]["duration_ms"],
            "event": "http_request",
            "level": "info",
            "method": "GET",
            "outcome": "completed",
            "path": "/api/jobs",
            "request_id": "worker-request-123",
            "status_code": 200,
        }
    ]
    assert isinstance(messages[0]["duration_ms"], float)
    assert messages[0]["duration_ms"] >= 0


def test_invalid_request_id_is_replaced(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    response = client.get(
        "/api/jobs",
        headers={"X-Request-ID": "invalid request id"},
    )

    assert response.status_code == 200
    generated_request_id = response.headers["X-Request-ID"]
    assert generated_request_id != "invalid request id"
    assert re.fullmatch(r"[0-9a-f]{32}", generated_request_id)


def test_unhandled_error_response_keeps_request_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    access_log_records: list[logging.LogRecord],
) -> None:
    request_id = "08b8ce83-8423-4fe6-8aa1-966d6710ad74"
    captured: list[tuple[Exception, dict[str, str | None]]] = []
    monkeypatch.setattr(
        api_module,
        "capture_unhandled_exception",
        lambda error, **context: captured.append((error, context)),
    )
    app = create_app(
        Settings(
            data_dir=tmp_path,
            parser_provider="mock",
            recommendation_provider="mock",
        )
    )

    @app.app.app.get("/api/test-crash")
    def crash() -> None:
        raise RuntimeError("test crash")

    client = TestClient(app, raise_server_exceptions=False)
    response = client.get(
        "/api/test-crash",
        headers={
            "Origin": "http://localhost:5173",
            "X-Request-ID": request_id,
        },
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert response.headers["X-Request-ID"] == request_id
    assert response.headers["Access-Control-Allow-Origin"] == (
        "http://localhost:5173"
    )
    assert response.headers["Access-Control-Expose-Headers"] == CORS_EXPOSED_HEADERS
    access_events = [
        json.loads(record.message)
        for record in access_log_records
        if record.name == "poker.access"
    ]
    assert len(access_events) == 1
    assert access_events[0]["request_id"] == request_id
    assert access_events[0]["status_code"] == 500
    assert access_events[0]["outcome"] == "failed"
    assert len(captured) == 1
    assert str(captured[0][0]) == "test crash"
    assert captured[0][1] == {
        "request_id": request_id,
        "method": "GET",
        "route": "/api/test-crash",
    }


def test_stream_failure_is_logged_after_response_start(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    app = create_app(
        Settings(
            data_dir=tmp_path,
            parser_provider="mock",
            recommendation_provider="mock",
        )
    )

    def stream_chunks():
        yield b"partial"
        assert not [
            record
            for record in access_log_records
            if record.name == "poker.access"
        ]
        raise RuntimeError("stream failed")

    @app.app.app.get("/api/test-stream")
    def stream() -> StreamingResponse:
        return StreamingResponse(stream_chunks())

    client = TestClient(app, raise_server_exceptions=False)
    response = client.get(
        "/api/test-stream",
        headers={"X-Request-ID": "failed-stream-123"},
    )

    assert response.status_code == 200
    access_events = [
        json.loads(record.message)
        for record in access_log_records
        if record.name == "poker.access"
    ]
    assert len(access_events) == 1
    assert access_events[0]["request_id"] == "failed-stream-123"
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "failed"


def test_client_disconnect_marks_file_response_failed(
    access_log_records: list[logging.LogRecord],
) -> None:
    received_messages = iter([
        {"type": "http.request", "body": b"", "more_body": False},
        {"type": "http.disconnect"},
    ])
    sent_messages: list[dict[str, object]] = []

    async def receive() -> dict[str, object]:
        await asyncio.sleep(0)
        return next(received_messages)

    async def send(message: dict[str, object]) -> None:
        sent_messages.append(message)
        await asyncio.sleep(0)

    async def file_response(
        _scope: dict[str, object],
        _receive,
        send_response,
    ) -> None:
        await asyncio.sleep(0)
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        await send_response({
            "type": "http.response.body",
            "body": b"partial",
            "more_body": True,
        })
        await asyncio.sleep(0)
        await send_response({
            "type": "http.response.body",
            "body": b"complete",
            "more_body": False,
        })

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/jobs/example/image",
        "raw_path": b"/api/jobs/example/image",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(
        api_module.RequestObservabilityMiddleware(file_response)(
            scope,
            receive,
            send,
        )
    )

    response_headers = dict(sent_messages[0]["headers"])
    assert b"x-request-id" in response_headers
    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "failed"


def test_client_disconnect_during_pathsend_marks_response_failed(
    access_log_records: list[logging.LogRecord],
) -> None:
    pathsend_started = asyncio.Event()
    disconnect_delivered = asyncio.Event()
    receive_count = 0

    async def receive() -> dict[str, object]:
        nonlocal receive_count
        receive_count += 1
        if receive_count == 1:
            return {"type": "http.request", "body": b"", "more_body": False}
        await pathsend_started.wait()
        disconnect_delivered.set()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.pathsend":
            pathsend_started.set()
            await disconnect_delivered.wait()
            await asyncio.sleep(0)

    async def file_response(
        _scope: dict[str, object],
        _receive,
        send_response,
    ) -> None:
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        await send_response({
            "type": "http.response.pathsend",
            "path": "/tmp/example.png",
        })

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "extensions": {"http.response.pathsend": {}},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/jobs/example/image",
        "raw_path": b"/api/jobs/example/image",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(
        api_module.RequestObservabilityMiddleware(file_response)(
            scope,
            receive,
            send,
        )
    )

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "failed"


def test_client_disconnect_during_final_body_send_marks_response_failed(
    access_log_records: list[logging.LogRecord],
) -> None:
    final_send_started = asyncio.Event()
    disconnect_delivered = asyncio.Event()
    receive_count = 0

    async def receive() -> dict[str, object]:
        nonlocal receive_count
        receive_count += 1
        if receive_count == 1:
            return {"type": "http.request", "body": b"", "more_body": False}
        await final_send_started.wait()
        disconnect_delivered.set()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        if (
            message["type"] == "http.response.body"
            and not message.get("more_body", False)
        ):
            final_send_started.set()
            await disconnect_delivered.wait()
            await asyncio.sleep(0)

    async def file_response(
        _scope: dict[str, object],
        _receive,
        send_response,
    ) -> None:
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        await send_response({
            "type": "http.response.body",
            "body": b"complete",
            "more_body": False,
        })

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/jobs/example/image",
        "raw_path": b"/api/jobs/example/image",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(
        api_module.RequestObservabilityMiddleware(file_response)(
            scope,
            receive,
            send,
        )
    )

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "failed"


def test_rejected_upload_monitors_receive_only_after_response_start(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    receive_calls = 0
    sent_messages: list[dict[str, object]] = []

    async def receive() -> dict[str, object]:
        nonlocal receive_calls
        assert sent_messages
        assert sent_messages[0]["type"] == "http.response.start"
        receive_calls += 1
        await asyncio.Event().wait()
        raise AssertionError("receive monitor should be cancelled")

    async def send(message: dict[str, object]) -> None:
        sent_messages.append(message)
        await asyncio.sleep(0)

    app = create_app(
        Settings(
            data_dir=tmp_path,
            parser_provider="mock",
            recommendation_provider="mock",
            proxy_shared_secret="worker-to-backend-secret-value-123",
        )
    )

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/jobs",
        "raw_path": b"/api/jobs",
        "query_string": b"",
        "headers": [
            (b"content-length", b"1048576"),
            (b"content-type", b"multipart/form-data; boundary=unread"),
            (b"expect", b"100-continue"),
        ],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(app(scope, receive, send))

    assert receive_calls == 1
    assert sent_messages[0]["type"] == "http.response.start"
    assert sent_messages[0]["status"] == 401
    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 401
    assert access_events[0]["outcome"] == "completed"


def test_disconnect_during_rejected_upload_response_is_logged_as_failed(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    response_started = asyncio.Event()
    final_send_started = asyncio.Event()
    disconnect_delivered = asyncio.Event()
    received_messages = iter([
        {
            "type": "http.request",
            "body": b"first unread upload frame",
            "more_body": True,
        },
        {
            "type": "http.request",
            "body": b"second unread upload frame",
            "more_body": True,
        },
        {"type": "http.disconnect"},
    ])

    async def receive() -> dict[str, object]:
        assert response_started.is_set()
        await final_send_started.wait()
        message = next(received_messages)
        if message["type"] == "http.disconnect":
            disconnect_delivered.set()
        return message

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            response_started.set()
        elif (
            message["type"] == "http.response.body"
            and not message.get("more_body", False)
        ):
            final_send_started.set()
            await disconnect_delivered.wait()

    app = create_app(
        Settings(
            data_dir=tmp_path,
            parser_provider="mock",
            recommendation_provider="mock",
            proxy_shared_secret="worker-to-backend-secret-value-123",
        )
    )
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/jobs",
        "raw_path": b"/api/jobs",
        "query_string": b"",
        "headers": [
            (b"content-length", b"1048576"),
            (b"content-type", b"multipart/form-data; boundary=unread"),
            (b"expect", b"100-continue"),
        ],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(app(scope, receive, send))

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 401
    assert access_events[0]["outcome"] == "failed"


def test_disconnect_during_successful_unread_body_response_is_logged_as_failed(
    access_log_records: list[logging.LogRecord],
) -> None:
    response_started = asyncio.Event()
    final_send_started = asyncio.Event()
    disconnect_delivered = asyncio.Event()
    received_messages = iter([
        {
            "type": "http.request",
            "body": b"first unread request frame",
            "more_body": True,
        },
        {
            "type": "http.request",
            "body": b"second unread request frame",
            "more_body": True,
        },
        {"type": "http.disconnect"},
    ])

    async def receive() -> dict[str, object]:
        assert response_started.is_set()
        await final_send_started.wait()
        message = next(received_messages)
        if message["type"] == "http.disconnect":
            disconnect_delivered.set()
        return message

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            response_started.set()
        elif (
            message["type"] == "http.response.body"
            and not message.get("more_body", False)
        ):
            final_send_started.set()
            await disconnect_delivered.wait()

    async def successful_short_circuit(
        _scope: dict[str, object],
        _receive,
        send_response,
    ) -> None:
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        await send_response({
            "type": "http.response.body",
            "body": b"complete",
            "more_body": False,
        })

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/jobs",
        "raw_path": b"/api/jobs",
        "query_string": b"",
        "headers": [(b"content-length", b"1048576")],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(
        api_module.RequestObservabilityMiddleware(successful_short_circuit)(
            scope,
            receive,
            send,
        )
    )

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "failed"


def test_response_start_does_not_create_concurrent_receive_calls(
    access_log_records: list[logging.LogRecord],
) -> None:
    first_receive_started = asyncio.Event()
    release_first_receive = asyncio.Event()
    disconnect_delivered = asyncio.Event()
    receive_calls = 0
    active_receive_calls = 0
    maximum_active_receive_calls = 0

    async def receive() -> dict[str, object]:
        nonlocal active_receive_calls, maximum_active_receive_calls
        nonlocal receive_calls
        receive_calls += 1
        active_receive_calls += 1
        maximum_active_receive_calls = max(
            maximum_active_receive_calls,
            active_receive_calls,
        )
        try:
            if receive_calls == 1:
                first_receive_started.set()
                await release_first_receive.wait()
                return {
                    "type": "http.request",
                    "body": b"partial request",
                    "more_body": True,
                }
            disconnect_delivered.set()
            return {"type": "http.disconnect"}
        finally:
            active_receive_calls -= 1

    async def send(_message: dict[str, object]) -> None:
        await asyncio.sleep(0)

    async def overlapping_response(
        _scope: dict[str, object],
        receive_request,
        send_response,
    ) -> None:
        first_receive = asyncio.create_task(receive_request())
        await first_receive_started.wait()
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        release_first_receive.set()
        await first_receive
        await disconnect_delivered.wait()
        await send_response({
            "type": "http.response.body",
            "body": b"complete",
            "more_body": False,
        })

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/jobs",
        "raw_path": b"/api/jobs",
        "query_string": b"",
        "headers": [(b"content-length", b"1024")],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(
        api_module.RequestObservabilityMiddleware(overlapping_response)(
            scope,
            receive,
            send,
        )
    )

    assert receive_calls == 2
    assert maximum_active_receive_calls == 1
    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["outcome"] == "failed"


def test_preexisting_disconnect_is_seen_before_synchronous_final_send(
    access_log_records: list[logging.LogRecord],
) -> None:
    response_started = False

    async def receive() -> dict[str, object]:
        assert response_started
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        nonlocal response_started
        if message["type"] == "http.response.start":
            response_started = True

    async def synchronous_response(
        _scope: dict[str, object],
        _receive,
        send_response,
    ) -> None:
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        await send_response({
            "type": "http.response.body",
            "body": b"complete",
            "more_body": False,
        })

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/jobs",
        "raw_path": b"/api/jobs",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }

    asyncio.run(
        api_module.RequestObservabilityMiddleware(synchronous_response)(
            scope,
            receive,
            send,
        )
    )

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "failed"


def test_completed_response_is_logged_before_post_response_failure(
    access_log_records: list[logging.LogRecord],
) -> None:
    async def receive() -> dict[str, object]:
        await asyncio.Event().wait()
        raise AssertionError("receive should be cancelled")

    async def send(_message: dict[str, object]) -> None:
        await asyncio.sleep(0)

    async def response_then_fail(
        _scope: dict[str, object],
        _receive,
        send_response,
    ) -> None:
        await send_response({
            "type": "http.response.start",
            "status": 200,
            "headers": [],
        })
        await send_response({
            "type": "http.response.body",
            "body": b"complete",
            "more_body": False,
        })
        access_events = [
            json.loads(record.message) for record in access_log_records
        ]
        assert len(access_events) == 1
        assert access_events[0]["outcome"] == "completed"
        raise RuntimeError("background task failed")

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/benchmarks/imports/example",
        "raw_path": b"/api/benchmarks/imports/example",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {api_module.BACKGROUND_TASK_STATE_KEY: True},
    }

    with pytest.raises(RuntimeError, match="background task failed"):
        asyncio.run(
            api_module.RequestObservabilityMiddleware(response_then_fail)(
                scope,
                receive,
                send,
            )
        )

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "completed"


def test_benchmark_recovery_poll_logs_before_background_import_finishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    access_log_records: list[logging.LogRecord],
) -> None:
    request_id = "observed-background-import"
    FileBenchmarkStore(tmp_path).begin_import(request_id, b"test archive")
    import_started = Event()
    release_import = Event()

    def block_import_parse(*_args: object, **_kwargs: object):
        import_started.set()
        assert release_import.wait(timeout=2)
        raise OSError("simulated interrupted background import")

    monkeypatch.setattr(
        api_module,
        "parse_parser_dataset_archive",
        block_import_parse,
    )
    client = make_client(tmp_path)
    responses: list[object] = []

    def poll_import() -> None:
        responses.append(client.get(f"/api/benchmarks/imports/{request_id}"))

    poll_thread = Thread(target=poll_import)
    poll_thread.start()
    assert import_started.wait(timeout=2)

    access_events = [json.loads(record.message) for record in access_log_records]
    assert len(access_events) == 1
    assert access_events[0]["path"] == (
        f"/api/benchmarks/imports/{request_id}"
    )
    assert access_events[0]["status_code"] == 200
    assert access_events[0]["outcome"] == "completed"
    assert poll_thread.is_alive()

    release_import.set()
    poll_thread.join(timeout=2)
    assert not poll_thread.is_alive()
    assert len(responses) == 1
    assert responses[0].status_code == 200


def test_cors_preflight_is_observed(
    tmp_path: Path,
    access_log_records: list[logging.LogRecord],
) -> None:
    client = make_client(tmp_path)

    response = client.options(
        "/api/jobs",
        headers={
            "Access-Control-Request-Headers": "X-Recommendation-Request-ID",
            "Access-Control-Request-Method": "POST",
            "Origin": "http://localhost:5173",
            "X-Request-ID": "preflight-request-123",
        },
    )

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "preflight-request-123"
    access_events = [
        json.loads(record.message)
        for record in access_log_records
        if record.name == "poker.access"
    ]
    assert len(access_events) == 1
    assert access_events[0]["method"] == "OPTIONS"
    assert access_events[0]["request_id"] == "preflight-request-123"
    assert access_events[0]["outcome"] == "completed"


def test_access_logger_formats_events_as_plain_json() -> None:
    handler = next(
        handler
        for handler in api_module.LOGGER.handlers
        if handler.get_name() == api_module.ACCESS_LOG_HANDLER_NAME
    )
    message = '{"event":"http_request","level":"info"}'
    record = api_module.LOGGER.makeRecord(
        api_module.LOGGER.name,
        logging.INFO,
        __file__,
        1,
        message,
        (),
        None,
    )

    assert api_module.LOGGER.propagate is False
    assert handler.format(record) == message


def test_cors_exposes_request_id_header(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    response = client.get(
        "/api/jobs",
        headers={"Origin": "http://localhost:5173"},
    )

    assert response.status_code == 200
    assert response.headers["Access-Control-Expose-Headers"] == CORS_EXPOSED_HEADERS


def test_proxy_shared_secret_protects_api_but_not_health(tmp_path: Path) -> None:
    proxy_secret = "worker-to-backend-secret-value-123"
    client = make_client(tmp_path, proxy_shared_secret=proxy_secret)

    assert client.get("/api/health").status_code == 200
    rejected = client.get(
        "/api/jobs",
        headers={
            "Origin": "http://localhost:5173",
            "X-Request-ID": "rejected-request-123",
        },
    )
    assert rejected.status_code == 401
    assert rejected.headers["X-Request-ID"] == "rejected-request-123"
    assert rejected.headers["Access-Control-Allow-Origin"] == (
        "http://localhost:5173"
    )
    assert rejected.headers["Access-Control-Expose-Headers"] == CORS_EXPOSED_HEADERS
    assert client.get(
        "/api/jobs",
        headers={"X-Poker-Proxy-Secret": "incorrect-secret-value-123456789"},
    ).status_code == 401

    authorized = client.get(
        "/api/jobs",
        headers={"X-Poker-Proxy-Secret": proxy_secret},
    )

    assert authorized.status_code == 200
    assert authorized.json()["jobs"] == []


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

    monkeypatch.setattr(api_module, "build_provider", capture_provider)
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
        api_module,
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


def test_upload_persists_client_request_identity(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    request_id = "08b8ce83-8423-4fe6-8aa1-966d6710ad74"

    response = upload_job(client, upload_request_id=request_id)

    assert response.status_code == 201
    assert response.json()["upload_request_id"] == request_id
    assert load_only_job(tmp_path).upload_request_id == request_id


def test_processing_queue_pages_unarchived_jobs_in_stable_order(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_ids = [
        upload_job(client, filename=f"queue-{index}.png").json()["id"]
        for index in range(4)
    ]
    approve_job(client, job_ids[1])
    client.put("/api/history", json={"job_ids": [job_ids[1]]})
    benchmark_only_id = upload_job(
        client,
        filename="benchmark-only.png",
    ).json()["id"]
    store = FileJobStore(tmp_path)
    benchmark_only = store.get(benchmark_only_id)
    benchmark_only.parser_result = None
    benchmark_only.approved_state = APPROVED_STATE
    benchmark_only.benchmark_included = True
    benchmark_only.status = "approved"
    store.save(benchmark_only)

    first_page = client.get("/api/jobs?limit=2")
    second_page = client.get("/api/jobs?limit=2&offset=2")
    changed_job = store.get(job_ids[2])
    changed_job.error = "Needs another look"
    store.save(changed_job)
    changed_page = client.get("/api/jobs?limit=2")

    assert first_page.status_code == 200
    assert second_page.status_code == 200
    assert first_page.json()["total"] == 3
    assert [job["id"] for job in first_page.json()["jobs"]] == [
        job_ids[0],
        job_ids[2],
    ]
    assert [job["id"] for job in second_page.json()["jobs"]] == [job_ids[3]]
    assert first_page.json()["snapshot_version"] == second_page.json()["snapshot_version"]
    assert changed_page.json()["snapshot_version"] != first_page.json()["snapshot_version"]
    assert client.get("/api/jobs?offset=-1").status_code == 422


def test_processing_queue_keeps_mutated_benchmark_imports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingProvider:
        name = "failing"
        required_fields = ["hero_cards", "street"]

        def required_fields_for(self, state: object):
            return self.required_fields

        def recommend(self, request: object):
            raise ProviderError("provider exploded")

    client = make_client(tmp_path)
    pristine_id = upload_job(client, filename="pristine-import.png").json()["id"]
    decision_id = upload_job(client, filename="decision-import.png").json()["id"]
    failed_id = upload_job(client, filename="failed-import.png").json()["id"]
    store = FileJobStore(tmp_path)
    for job_id in (pristine_id, decision_id, failed_id):
        approve_job(client, job_id)
        imported_job = store.get(job_id)
        imported_job.parser_result = None
        imported_job.benchmark_included = True
        store.save(imported_job)

    decision = client.put(
        f"/api/jobs/{decision_id}/decision",
        json={"action": "call", "sizing": None, "certainty": "medium"},
    )
    monkeypatch.setattr("app.api.build_provider", lambda settings: FailingProvider())
    failed_recommendation = client.post(f"/api/jobs/{failed_id}/recommend")
    queue = client.get("/api/jobs")

    assert decision.status_code == 200
    assert failed_recommendation.status_code == 502
    assert queue.status_code == 200
    assert queue.json()["total"] == 2
    assert [job["id"] for job in queue.json()["jobs"]] == [decision_id, failed_id]
    assert queue.json()["jobs"][0]["training_decision"]["action"] == "call"
    assert queue.json()["jobs"][1]["status"] == "error"
    assert queue.json()["jobs"][1]["error"] == "provider exploded"


def test_processing_queue_keeps_correctable_benchmark_attempts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CorrectableProvider:
        name = "correctable"
        required_fields = ["hero_cards", "street"]

        def required_fields_for(self, state: object):
            return self.required_fields

        def recommend(self, request: object):
            raise ProviderInputError("Add the missing table context")

    client = make_client(tmp_path)
    job_id = upload_job(client, filename="correctable-import.png").json()["id"]
    approve_job(client, job_id)
    store = FileJobStore(tmp_path)
    imported_job = store.get(job_id)
    imported_job.parser_result = None
    imported_job.benchmark_included = True
    store.save(imported_job)
    monkeypatch.setattr("app.api.build_provider", lambda settings: CorrectableProvider())

    recommendation = client.post(
        f"/api/jobs/{job_id}/recommend",
        headers={"X-Recommendation-Request-ID": "correctable-attempt"},
    )
    queue = client.get("/api/jobs")

    assert recommendation.status_code == 422
    assert queue.status_code == 200
    assert queue.json()["total"] == 1
    assert queue.json()["jobs"][0]["id"] == job_id
    assert queue.json()["jobs"][0]["recommendation_request_id"] == (
        "correctable-attempt"
    )


def test_job_metadata_is_normalized_persisted_and_searchable(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="anonymous-table.png").json()["id"]

    updated = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={
            "title": "  Tricky turn decision  ",
            "notes": "  Villain had been playing aggressively.  ",
            "tags": [" Turn ", "Study", "turn", ""],
        },
    )

    assert updated.status_code == 200
    assert updated.json()["title"] == "Tricky turn decision"
    assert updated.json()["notes"] == "Villain had been playing aggressively."
    assert updated.json()["tags"] == ["Turn", "Study"]
    persisted = FileJobStore(tmp_path).get(job_id)
    assert persisted.title == "Tricky turn decision"
    assert persisted.notes == "Villain had been playing aggressively."
    assert persisted.tags == ["Turn", "Study"]

    approve_job(client, job_id)
    client.put("/api/history", json={"job_ids": [job_id]})
    for query in ("tricky decision", "aggressively", "study"):
        result = client.get("/api/history", params={"query": query})
        assert result.status_code == 200
        assert [job["id"] for job in result.json()["jobs"]] == [job_id]

    cleared = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={"title": " ", "notes": "", "tags": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["title"] is None
    assert cleared.json()["notes"] is None
    assert cleared.json()["tags"] == []


def test_job_metadata_rejects_oversized_excess_or_ambiguous_tags(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]

    oversized = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={"title": None, "notes": None, "tags": ["x" * 33]},
    )
    excessive = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={
            "title": None,
            "notes": None,
            "tags": [f"tag-{index}" for index in range(11)],
        },
    )
    comma_separated = client.put(
        f"/api/jobs/{job_id}/metadata",
        json={"title": None, "notes": None, "tags": ["turn,river"]},
    )

    assert oversized.status_code == 422
    assert excessive.status_code == 422
    assert comma_separated.status_code == 422
    assert FileJobStore(tmp_path).get(job_id).tags == []


def test_delete_removes_unarchivable_job_and_image(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="incomplete-table.png").json()["id"]
    job_dir = tmp_path / "jobs" / job_id

    deleted = client.delete(f"/api/jobs/{job_id}")

    assert deleted.status_code == 204
    assert deleted.content == b""
    assert not job_dir.exists()
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert client.get(f"/api/jobs/{job_id}/image").status_code == 404
    assert client.get("/api/jobs").json()["total"] == 0
    assert client.delete(f"/api/jobs/{job_id}").status_code == 404


def test_delete_removes_archived_job_from_history(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put("/api/history", json={"job_ids": [job_id]})

    deleted = client.delete(f"/api/jobs/{job_id}")

    assert deleted.status_code == 204
    assert client.get("/api/history").json()["total"] == 0


def test_history_persists_only_explicitly_archived_ready_jobs(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    parsed_id = upload_job(client, filename="parsed.png").json()["id"]
    first_id = upload_job(client, filename="first.png").json()["id"]
    second_id = upload_job(client, filename="second.png").json()["id"]
    approve_job(client, first_id)
    approve_job(client, second_id)
    client.post(f"/api/jobs/{second_id}/recommend")

    empty_history = client.get("/api/history")
    rejected = client.put("/api/history", json={"job_ids": [parsed_id]})
    archived = client.put(
        "/api/history",
        json={"job_ids": [first_id, second_id]},
    )

    assert empty_history.status_code == 200
    assert empty_history.json()["total"] == 0
    assert empty_history.json()["jobs"] == []
    assert empty_history.json()["snapshot_version"]
    assert rejected.status_code == 409
    assert rejected.json()["detail"] == (
        "Only successful approved or recommended jobs can be moved to history"
    )
    assert FileJobStore(tmp_path).get(parsed_id).archived_at is None
    assert archived.status_code == 200
    history = archived.json()
    assert history["total"] == 2
    assert [job["id"] for job in history["jobs"]] == [second_id, first_id]
    assert all(job["archived_at"] for job in history["jobs"])

    store = FileJobStore(tmp_path)
    replayed_job = store.get(first_id)
    persisted_at = replayed_job.archived_at
    replayed_job.status = "error"
    replayed_job.error = "Later archived review failed"
    store.save(replayed_job)
    repeated = client.put("/api/history?limit=1", json={"job_ids": [first_id]})

    assert repeated.status_code == 200
    assert repeated.json()["total"] == 2
    assert len(repeated.json()["jobs"]) == 1
    assert store.get(first_id).archived_at == persisted_at


def test_history_archive_is_atomic_when_a_job_is_missing(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        "/api/history",
        json={"job_ids": [job_id, "f" * 32]},
    )

    assert response.status_code == 404
    empty_history = client.get("/api/history").json()
    assert empty_history["total"] == 0
    assert empty_history["jobs"] == []
    assert FileJobStore(tmp_path).get(job_id).archived_at is None


def test_processing_queue_waits_for_batch_archive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    job_ids = [
        upload_job(client, filename=f"archive-{index}.png").json()["id"]
        for index in range(2)
    ]
    for job_id in job_ids:
        approve_job(client, job_id)

    first_archive_saved = Event()
    release_archive = Event()
    processing_finished = Event()
    responses: dict[str, object] = {}
    original_save = FileJobStore.save

    def paused_save(store: FileJobStore, job):
        saved = original_save(store, job)
        if job.archived_at is not None and not first_archive_saved.is_set():
            first_archive_saved.set()
            assert release_archive.wait(timeout=2)
        return saved

    monkeypatch.setattr(FileJobStore, "save", paused_save)
    archive_thread = Thread(
        target=lambda: responses.update(
            archive=client.put("/api/history", json={"job_ids": job_ids}),
        ),
    )

    def read_processing_queue() -> None:
        responses["processing"] = client.get("/api/jobs")
        processing_finished.set()

    processing_thread = Thread(target=read_processing_queue)
    archive_thread.start()
    try:
        assert first_archive_saved.wait(timeout=2)
        processing_thread.start()
        assert not processing_finished.wait(timeout=0.1)
    finally:
        release_archive.set()
        archive_thread.join(timeout=2)
        processing_thread.join(timeout=2)

    assert not archive_thread.is_alive()
    assert not processing_thread.is_alive()
    assert responses["archive"].status_code == 200
    assert responses["processing"].status_code == 200
    assert responses["processing"].json()["total"] == 0
    assert responses["processing"].json()["jobs"] == []


def test_history_pages_archived_jobs_in_stable_newest_first_order(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    job_ids = [
        upload_job(client, filename=f"history-{index}.png").json()["id"]
        for index in range(4)
    ]
    for job_id in job_ids:
        approve_job(client, job_id)
    archived = client.put("/api/history", json={"job_ids": job_ids})

    first_page = client.get("/api/history?limit=2")
    page = client.get("/api/history?limit=2&offset=1")
    store = FileJobStore(tmp_path)
    changed_job = store.get(job_ids[0])
    changed_job.training_review_note = "Snapshot content changed."
    store.save(changed_job)
    changed_page = client.get("/api/history?limit=2")

    assert archived.status_code == 200
    assert first_page.status_code == 200
    assert page.status_code == 200
    assert page.json()["total"] == 4
    assert first_page.json()["snapshot_version"] == page.json()["snapshot_version"]
    assert [job["id"] for job in page.json()["jobs"]] == [
        job_ids[2],
        job_ids[1],
    ]
    assert changed_page.json()["snapshot_version"] != page.json()["snapshot_version"]
    assert client.get("/api/history?offset=-1").status_code == 422


def test_history_scan_does_not_block_an_unarchived_job_update(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    archived_id = upload_job(client, filename="archived.png").json()["id"]
    active_id = upload_job(client, filename="active.png").json()["id"]
    approve_job(client, archived_id)
    client.put("/api/history", json={"job_ids": [archived_id]})

    history_started = Event()
    release_history = Event()
    approval_finished = Event()
    responses: dict[str, object] = {}
    original_list = FileJobStore.list

    def paused_list(store: FileJobStore):
        jobs = original_list(store)
        history_started.set()
        assert release_history.wait(timeout=2)
        return jobs

    monkeypatch.setattr(FileJobStore, "list", paused_list)

    history_thread = Thread(
        target=lambda: responses.update(history=client.get("/api/history")),
    )

    def run_approval() -> None:
        responses["approval"] = approve_job(client, active_id)
        approval_finished.set()

    approval_thread = Thread(target=run_approval)
    history_thread.start()
    try:
        assert history_started.wait(timeout=2)
        approval_thread.start()
        assert approval_finished.wait(timeout=1)
    finally:
        release_history.set()
        history_thread.join(timeout=2)
        approval_thread.join(timeout=2)

    assert not history_thread.is_alive()
    assert not approval_thread.is_alive()
    assert responses["history"].status_code == 200
    assert responses["approval"].status_code == 200


def test_history_scan_serializes_an_archived_job_update(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client, filename="archived.png").json()["id"]
    approve_job(client, job_id)
    client.put("/api/history", json={"job_ids": [job_id]})

    history_started = Event()
    release_history = Event()
    approval_started = Event()
    approval_finished = Event()
    responses: dict[str, object] = {}
    original_list = FileJobStore.list

    def paused_list(store: FileJobStore):
        jobs = original_list(store)
        history_started.set()
        assert release_history.wait(timeout=2)
        return jobs

    monkeypatch.setattr(FileJobStore, "list", paused_list)

    history_thread = Thread(
        target=lambda: responses.update(history=client.get("/api/history")),
    )
    corrected_state = {**APPROVED_STATE, "pot_size": 21.0}

    def run_approval() -> None:
        approval_started.set()
        responses["approval"] = approve_job(client, job_id, corrected_state)
        approval_finished.set()

    approval_thread = Thread(target=run_approval)
    history_thread.start()
    try:
        assert history_started.wait(timeout=2)
        approval_thread.start()
        assert approval_started.wait(timeout=2)
        assert not approval_finished.wait(timeout=0.1)
    finally:
        release_history.set()
        history_thread.join(timeout=2)
        approval_thread.join(timeout=2)

    assert not history_thread.is_alive()
    assert not approval_thread.is_alive()
    assert responses["history"].status_code == 200
    assert responses["history"].json()["jobs"][0]["approved_state"]["pot_size"] == 12.5
    assert responses["approval"].status_code == 200
    assert responses["approval"].json()["approved_state"]["pot_size"] == 21


def test_history_searches_archived_poker_context_before_paging(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    matching_id = upload_job(client, filename="river-bluff.png").json()["id"]
    other_id = upload_job(client, filename="value-line.png").json()["id"]
    matching_state = {
        **APPROVED_STATE,
        "hero_cards": [
            {"rank": "7", "suit": "diamonds"},
            {"rank": "A", "suit": "hearts"},
        ],
        "street": "turn",
    }
    approve_job(client, matching_id, matching_state)
    approve_job(client, other_id)
    client.post(f"/api/jobs/{matching_id}/recommend")
    client.post(f"/api/jobs/{other_id}/recommend")
    client.put(
        "/api/history",
        json={"job_ids": [matching_id, other_id]},
    )

    poker_terms = client.get(
        "/api/history",
        params={"query": "7♦ TURN call", "limit": 1},
    )
    filename = client.get(
        "/api/history",
        params={"query": "RIVER-BLUFF"},
    )
    no_match = client.get(
        "/api/history",
        params={"query": "river raise"},
    )
    separator_only = client.get(
        "/api/history",
        params={"query": ", ,"},
    )

    assert poker_terms.status_code == 200
    assert poker_terms.json()["total"] == 1
    assert [job["id"] for job in poker_terms.json()["jobs"]] == [matching_id]
    assert [job["id"] for job in filename.json()["jobs"]] == [matching_id]
    assert no_match.json()["total"] == 0
    assert no_match.json()["jobs"] == []
    assert separator_only.status_code == 200
    assert separator_only.json()["total"] == 0
    assert separator_only.json()["jobs"] == []
    assert client.get(
        "/api/history",
        params={"query": "x" * 101},
    ).status_code == 422


def test_history_card_queries_do_not_match_recommendation_prose(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path, recommendation_provider="rule_based")
    ace_spades_id = upload_job(client, filename="ace-spades.png").json()["id"]
    other_id = upload_job(client, filename="other-hand.png").json()["id"]
    ace_spades_state = {
        **APPROVED_STATE,
        "hero_cards": [
            {"rank": "A", "suit": "spades"},
            {"rank": "K", "suit": "diamonds"},
        ],
    }
    other_state = {
        **APPROVED_STATE,
        "hero_cards": [
            {"rank": "Q", "suit": "clubs"},
            {"rank": "K", "suit": "diamonds"},
        ],
    }
    approve_job(client, ace_spades_id, ace_spades_state)
    approve_job(client, other_id, other_state)
    client.post(f"/api/jobs/{ace_spades_id}/recommend")
    client.post(f"/api/jobs/{other_id}/recommend")
    store = FileJobStore(tmp_path)
    other_job = store.get(other_id)
    other_job.training_review_note = (
        "Play as bluff when blockers support it. Ah, I missed the draw."
    )
    store.save(other_job)
    client.put(
        "/api/history",
        json={"job_ids": [ace_spades_id, other_id]},
    )

    for card_query in (
        "A♠",
        "a♠",
        "A♠︎",
        "A♠️",
        "As",
        "AsKd",
        "askd",
        "A♠K♦",
        "As,Kd",
        "as,kd",
        "A♠,K♦",
    ):
        response = client.get("/api/history", params={"query": card_query})

        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert [job["id"] for job in response.json()["jobs"]] == [ace_spades_id]

    prose_response = client.get(
        "/api/history",
        params={"query": "play as bluff"},
    )

    assert prose_response.status_code == 200
    assert prose_response.json()["total"] == 1
    assert [job["id"] for job in prose_response.json()["jobs"]] == [other_id]

    lowercase_prose_response = client.get(
        "/api/history",
        params={"query": "ah"},
    )
    canonical_card_response = client.get(
        "/api/history",
        params={"query": "Ah"},
    )

    assert lowercase_prose_response.status_code == 200
    assert lowercase_prose_response.json()["total"] == 1
    assert [job["id"] for job in lowercase_prose_response.json()["jobs"]] == [
        other_id
    ]
    assert canonical_card_response.status_code == 200
    assert canonical_card_response.json()["total"] == 0


def test_history_card_queries_match_screenshot_metadata_only(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    metadata_id = upload_job(
        client,
        filename="metadata-card-terms.png",
    ).json()["id"]
    prose_id = upload_job(
        client,
        filename="prose-card-terms.png",
    ).json()["id"]
    state_without_metadata_cards = {
        **APPROVED_STATE,
        "hero_cards": [
            {"rank": "Q", "suit": "clubs"},
            {"rank": "J", "suit": "spades"},
        ],
        "board_cards": [
            {"rank": "2", "suit": "hearts"},
            {"rank": "3", "suit": "diamonds"},
            {"rank": "4", "suit": "clubs"},
        ],
    }
    approve_job(client, metadata_id, state_without_metadata_cards)
    approve_job(client, prose_id, state_without_metadata_cards)
    metadata = client.put(
        f"/api/jobs/{metadata_id}/metadata",
        json={
            "title": "Ah bluff Th",
            "notes": "Review the Kd blocker with 10s",
            "tags": ["Qs study"],
        },
    )
    store = FileJobStore(tmp_path)
    prose_job = store.get(prose_id)
    prose_job.training_review_note = "Ah Kd Qs appeared only in review prose."
    store.save(prose_job)
    client.put(
        "/api/history",
        json={"job_ids": [metadata_id, prose_id]},
    )

    assert metadata.status_code == 200
    for query in (
        "Ah",
        "Kd",
        "Qs",
        "Ah bluff",
        "Kd blocker",
        "Qs study",
        "Th",
        "10h",
        "10h bluff",
        "10s",
        "Ts",
        "Ts blocker",
    ):
        response = client.get("/api/history", params={"query": query})

        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert [job["id"] for job in response.json()["jobs"]] == [metadata_id]


def test_history_rejects_duplicate_job_ids(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        "/api/history",
        json={"job_ids": [job_id, job_id]},
    )

    assert response.status_code == 422
    empty_history = client.get("/api/history").json()
    assert empty_history["total"] == 0
    assert empty_history["jobs"] == []


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


def test_records_training_decision_before_recommendation(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 7.5, "certainty": "high"},
    )

    assert response.status_code == 200
    decision = response.json()["training_decision"]
    assert decision["action"] == "raise"
    assert decision["sizing"] == 7.5
    assert decision["certainty"] == "high"
    assert decision["recorded_at"]
    persisted = FileJobStore(tmp_path).get(job_id).training_decision
    assert persisted.action == "raise"
    assert persisted.certainty == "high"


def test_training_progress_reports_completed_decision_reviews(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)
    client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": None, "certainty": "medium"},
    )
    client.post(f"/api/jobs/{job_id}/recommend")

    response = client.get("/api/training/progress")

    assert response.status_code == 200
    progress = response.json()
    assert progress["reviewed_hands"] == 1
    assert progress["certainty_summaries"] == [
        {
            "certainty": "medium",
            "hands": 1,
            "action_matches": 1,
            "exact_matches": 1,
            "needs_review_hands": 0,
            "action_accuracy": 1.0,
            "exact_accuracy": 1.0,
            "ev_compared_hands": 0,
            "average_ev_loss_bb": None,
            "trend": None,
        }
    ]
    assert progress["unrated_hands"] == 0
    assert progress["unrated_needs_review_hands"] == 0
    assert progress["recent_hands"][0]["decision_certainty"] == "medium"
    assert progress["action_matches"] == 1
    assert progress["exact_matches"] == 1
    assert progress["different_actions"] == 0
    assert progress["needs_review_hands"] == 0
    assert progress["action_accuracy"] == 1
    assert progress["exact_accuracy"] == 1
    assert progress["ev_compared_hands"] == 0
    assert progress["average_ev_loss_bb"] is None
    assert progress["trend"] is None
    assert progress["action_differences"] == []
    assert progress["street_summaries"][0]["street"] == "flop"
    assert progress["street_summaries"][0]["ev_compared_hands"] == 0
    assert progress["street_summaries"][0]["average_ev_loss_bb"] is None
    assert progress["recent_hands"][0]["job_id"] == job_id
    assert progress["recent_hands"][0]["outcome"] == "match"
    assert progress["recent_hands"][0]["ev_loss_bb"] is None
    assert progress["lesson_count"] == 0
    assert progress["lesson_matching_hands"] == 0
    assert progress["lesson_hands"] == []
    assert progress["review_street_counts"] == {}
    assert progress["review_queue_hands"] == 0
    assert progress["review_queue"] == []


def test_training_progress_validates_review_filters(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    filtered = client.get(
        "/api/training/progress"
        "?review_order=ev_loss"
        "&review_street=flop"
        "&review_certainty=high"
        "&review_decision_action=fold"
        "&review_recommended_action=call"
        "&lesson_order=ev_loss"
    )
    invalid_order = client.get("/api/training/progress?review_order=unknown")
    invalid_lesson_order = client.get(
        "/api/training/progress?lesson_order=unknown"
    )
    invalid_street = client.get("/api/training/progress?review_street=showdown")
    invalid_certainty = client.get(
        "/api/training/progress?review_certainty=very_sure"
    )
    invalid_lesson_street = client.get(
        "/api/training/progress?lesson_street=showdown"
    )
    oversized_lesson_query = client.get(
        f"/api/training/progress?lesson_query={'x' * 121}"
    )
    incomplete_difference = client.get(
        "/api/training/progress?review_decision_action=fold"
    )
    invalid_difference = client.get(
        "/api/training/progress"
        "?review_decision_action=jam"
        "&review_recommended_action=call"
    )
    invalid_solver_fallback = client.get(
        "/api/training/progress?solver_fallback_key=not-a-hash"
    )
    valid_solver_fallback = client.get(
        f"/api/training/progress?solver_fallback_key={'a' * 64}"
    )
    invalid_solver_route = client.get(
        "/api/training/progress?solver_route_key=not-a-hash"
    )
    valid_solver_route = client.get(
        f"/api/training/progress?solver_route_key={'b' * 64}"
    )
    invalid_solver_unattributed = client.get(
        "/api/training/progress?solver_unattributed=not-a-bool"
    )
    valid_solver_unattributed = client.get(
        "/api/training/progress?solver_unattributed=true"
    )
    invalid_recent_position = client.get(
        "/api/training/progress?recent_position=%20"
    )
    valid_recent_position = client.get(
        "/api/training/progress?recent_position=button"
    )
    valid_recent_unpositioned = client.get(
        "/api/training/progress?recent_unpositioned=true"
    )
    invalid_review_position = client.get(
        "/api/training/progress?review_position=%20"
    )
    valid_review_position = client.get(
        "/api/training/progress?review_position=button"
    )
    valid_review_unpositioned = client.get(
        "/api/training/progress?review_unpositioned=true"
    )
    invalid_recent_street = client.get(
        "/api/training/progress?recent_street=middle"
    )
    valid_recent_street = client.get(
        "/api/training/progress?recent_street=flop"
    )
    invalid_recent_certainty = client.get(
        "/api/training/progress?recent_certainty=very"
    )
    valid_recent_certainty = client.get(
        "/api/training/progress?recent_certainty=high"
    )
    valid_recent_unrated = client.get(
        "/api/training/progress?recent_certainty=unrated"
    )
    conflicting_position_filters = client.get(
        "/api/training/progress"
        "?recent_position=button"
        "&recent_unpositioned=true"
    )
    conflicting_review_position_filters = client.get(
        "/api/training/progress"
        "?review_position=button"
        "&review_unpositioned=true"
    )
    conflicting_position_solver_filters = client.get(
        "/api/training/progress"
        "?recent_position=button"
        f"&solver_route_key={'b' * 64}"
    )
    conflicting_street_position_filters = client.get(
        "/api/training/progress"
        "?recent_street=flop"
        "&recent_position=button"
    )
    conflicting_street_solver_filters = client.get(
        "/api/training/progress"
        "?recent_street=flop"
        f"&solver_route_key={'b' * 64}"
    )
    conflicting_certainty_street_filters = client.get(
        "/api/training/progress"
        "?recent_certainty=high"
        "&recent_street=flop"
    )
    conflicting_solver_filters = client.get(
        "/api/training/progress"
        f"?solver_fallback_key={'a' * 64}"
        f"&solver_route_key={'b' * 64}"
    )
    conflicting_unattributed_filter = client.get(
        "/api/training/progress"
        f"?solver_route_key={'b' * 64}"
        "&solver_unattributed=true"
    )

    assert filtered.status_code == 200
    assert invalid_order.status_code == 422
    assert invalid_lesson_order.status_code == 422
    assert invalid_street.status_code == 422
    assert invalid_certainty.status_code == 422
    assert invalid_lesson_street.status_code == 422
    assert oversized_lesson_query.status_code == 422
    assert incomplete_difference.status_code == 422
    assert incomplete_difference.json()["detail"] == (
        "review_decision_action and review_recommended_action "
        "must be provided together"
    )
    assert invalid_difference.status_code == 422
    assert invalid_solver_fallback.status_code == 422
    assert valid_solver_fallback.status_code == 200
    assert invalid_solver_route.status_code == 422
    assert valid_solver_route.status_code == 200
    assert invalid_solver_unattributed.status_code == 422
    assert valid_solver_unattributed.status_code == 200
    assert invalid_recent_position.status_code == 422
    assert valid_recent_position.status_code == 200
    assert valid_recent_unpositioned.status_code == 200
    assert invalid_review_position.status_code == 422
    assert valid_review_position.status_code == 200
    assert valid_review_unpositioned.status_code == 200
    assert invalid_recent_street.status_code == 422
    assert valid_recent_street.status_code == 200
    assert invalid_recent_certainty.status_code == 422
    assert valid_recent_certainty.status_code == 200
    assert valid_recent_unrated.status_code == 200
    assert conflicting_position_filters.status_code == 422
    assert conflicting_position_filters.json()["detail"] == (
        "recent_position and recent_unpositioned are mutually exclusive"
    )
    assert conflicting_review_position_filters.status_code == 422
    assert conflicting_review_position_filters.json()["detail"] == (
        "review_position and review_unpositioned are mutually exclusive"
    )
    assert conflicting_position_solver_filters.status_code == 422
    assert conflicting_position_solver_filters.json()["detail"] == (
        "position and solver recent-hand filters are mutually exclusive"
    )
    assert conflicting_street_position_filters.status_code == 422
    assert conflicting_street_position_filters.json()["detail"] == (
        "street, position, and solver recent-hand filters are mutually exclusive"
    )
    assert conflicting_street_solver_filters.status_code == 422
    assert conflicting_street_solver_filters.json()["detail"] == (
        "street, position, and solver recent-hand filters are mutually exclusive"
    )
    assert conflicting_certainty_street_filters.status_code == 422
    assert conflicting_certainty_street_filters.json()["detail"] == (
        "certainty, street, position, and solver recent-hand filters "
        "are mutually exclusive"
    )
    assert conflicting_solver_filters.status_code == 422
    assert conflicting_solver_filters.json()["detail"] == (
        "solver_fallback_key, solver_route_key, and solver_unattributed "
        "are mutually exclusive"
    )
    assert conflicting_unattributed_filter.status_code == 422
    assert conflicting_unattributed_filter.json()["detail"] == (
        conflicting_solver_filters.json()["detail"]
    )


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
    too_long = client.put(
        f"/api/jobs/{job_id}/training-review",
        json={"note": "x" * 1001},
    )
    response = client.put(
        f"/api/jobs/{job_id}/training-review",
        json={"note": "  Watch the call price and blockers.  "},
    )
    repeated = client.put(f"/api/jobs/{job_id}/training-review")
    after_review = client.get("/api/training/progress").json()
    updated = client.put(
        f"/api/jobs/{job_id}/training-review",
        json={"note": "Review blockers before raising."},
    )
    after_update = client.get("/api/training/progress").json()
    filtered_lesson = client.get(
        "/api/training/progress?lesson_street=flop&lesson_query=BLOCKERS"
    ).json()
    unmatched_lesson = client.get(
        "/api/training/progress?lesson_street=turn&lesson_query=blockers"
    ).json()
    exported_lesson = client.get(
        "/api/training/lessons/export?lesson_street=flop&lesson_query=BLOCKERS"
    )
    unmatched_export = client.get(
        "/api/training/lessons/export?lesson_street=turn&lesson_query=blockers"
    )
    reopened = client.delete(f"/api/jobs/{job_id}/training-review")
    repeated_reopen = client.delete(f"/api/jobs/{job_id}/training-review")
    after_reopen = client.get("/api/training/progress").json()

    assert before_review["needs_review_hands"] == 1
    assert before_review["review_queue"][0]["job_id"] == job_id
    assert too_long.status_code == 422
    assert response.status_code == 200
    assert response.json()["training_reviewed_at"]
    assert response.json()["training_review_note"] == (
        "Watch the call price and blockers."
    )
    assert repeated.status_code == 200
    assert repeated.json()["training_reviewed_at"] == response.json()["training_reviewed_at"]
    assert repeated.json()["training_review_note"] == response.json()["training_review_note"]
    assert after_review["reviewed_hands"] == 1
    assert after_review["different_actions"] == 1
    assert after_review["needs_review_hands"] == 0
    assert after_review["review_queue"] == []
    assert after_review["recent_hands"][0]["reviewed_at"] == response.json()["training_reviewed_at"]
    assert after_review["recent_hands"][0]["review_note"] == (
        "Watch the call price and blockers."
    )
    assert after_review["lesson_count"] == 1
    assert after_review["lesson_hands"][0]["job_id"] == job_id
    assert after_review["lesson_hands"][0]["review_note"] == (
        "Watch the call price and blockers."
    )
    assert updated.status_code == 200
    assert updated.json()["training_reviewed_at"] == response.json()["training_reviewed_at"]
    assert updated.json()["training_review_note"] == "Review blockers before raising."
    assert after_update["recent_hands"][0]["review_note"] == (
        "Review blockers before raising."
    )
    assert after_update["lesson_hands"][0]["review_note"] == (
        "Review blockers before raising."
    )
    assert filtered_lesson["lesson_count"] == 1
    assert filtered_lesson["lesson_matching_hands"] == 1
    assert filtered_lesson["lesson_hands"][0]["job_id"] == job_id
    assert unmatched_lesson["lesson_count"] == 1
    assert unmatched_lesson["lesson_matching_hands"] == 0
    assert unmatched_lesson["lesson_hands"] == []
    assert exported_lesson.status_code == 200
    assert exported_lesson.headers["content-type"].startswith("text/markdown")
    assert "poker-hero-lessons-" in exported_lesson.headers["content-disposition"]
    assert "## Ah Kd - Flop" in exported_lesson.text
    assert "- Board: Qs Jc 2h" in exported_lesson.text
    assert "- Position: `button`" in exported_lesson.text
    assert "- Pot: 12.5 BB" in exported_lesson.text
    assert "> Review blockers before raising." in exported_lesson.text
    assert unmatched_export.status_code == 409
    assert unmatched_export.json()["detail"] == (
        "No saved lesson notes match the selected filters"
    )
    assert reopened.status_code == 200
    assert reopened.json()["training_reviewed_at"] is None
    assert reopened.json()["training_review_note"] == "Review blockers before raising."
    assert repeated_reopen.status_code == 200
    assert repeated_reopen.json()["training_reviewed_at"] is None
    assert repeated_reopen.json()["training_review_note"] == (
        "Review blockers before raising."
    )
    assert after_reopen["reviewed_hands"] == 1
    assert after_reopen["different_actions"] == 1
    assert after_reopen["needs_review_hands"] == 1
    assert after_reopen["review_queue"][0]["job_id"] == job_id
    assert after_reopen["review_queue"][0]["review_note"] == (
        "Review blockers before raising."
    )
    assert after_reopen["recent_hands"][0]["reviewed_at"] is None
    assert after_reopen["recent_hands"][0]["review_note"] == (
        "Review blockers before raising."
    )
    assert after_reopen["lesson_count"] == 0
    assert after_reopen["lesson_hands"] == []
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


def test_training_decision_rejects_nonfinite_sizing(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        content=b'{"action":"raise","sizing":1e309}',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert response.json()["detail"][0]["input"] == "Infinity"
    assert FileJobStore(tmp_path).get(job_id).training_decision is None


def test_training_decision_rejects_zero_wager_sizing(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": 0},
    )

    assert response.status_code == 422
    assert FileJobStore(tmp_path).get(job_id).training_decision is None


@pytest.mark.parametrize("sizing", [True, "7.5"])
def test_training_decision_rejects_coerced_wager_sizing(
    tmp_path: Path,
    sizing: object,
) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "raise", "sizing": sizing},
    )

    assert response.status_code == 422
    assert FileJobStore(tmp_path).get(job_id).training_decision is None


def test_training_decision_rejects_unknown_certainty(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    job_id = upload_job(client).json()["id"]
    approve_job(client, job_id)

    response = client.put(
        f"/api/jobs/{job_id}/decision",
        json={"action": "call", "sizing": None, "certainty": "certain"},
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
    imported_job = FileJobStore(tmp_path).get(job_id)
    imported_job.parser_result = None
    imported_job.benchmark_included = True
    FileJobStore(tmp_path).save(imported_job)
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
    monkeypatch.setattr("app.api.build_provider", lambda settings: provider)
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

    monkeypatch.setattr("app.api.build_parser", lambda settings: SlowParser())
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
        "app.api.build_parser",
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

    monkeypatch.setattr("app.api.build_parser", lambda settings: SlowParser())
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

    monkeypatch.setattr("app.api.JOB_LOCK_STRIPES", 1)
    monkeypatch.setattr(
        "app.api.build_parser",
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

    monkeypatch.setattr("app.api.build_parser", lambda settings: FailingParser())
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

    monkeypatch.setattr("app.api.build_parser", lambda settings: FailingParser())
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
    monkeypatch.setattr("app.api.build_provider", lambda settings: FailingProvider())

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

    monkeypatch.setattr("app.api.build_provider", build_setup_provider)
    if failure_stage == "validation":
        monkeypatch.setattr(
            "app.api.missing_required_fields",
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
    target_client = make_client(
        target_dir,
        recommendation_provider="local_solver",
        local_solver_engine="local_ev",
    )

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
    assert imported_job.approved_state.model_dump(mode="json", exclude_none=True) == {
        **corrected_state,
        "preflop_action_history": [],
        "postflop_action_history": [],
    }
    assert imported_job.benchmark_included is True
    assert imported_job.status == "approved"
    assert imported_job.parser_result is None
    assert imported_job.recommendation is None
    assert imported_job.recommendation_provider == "local_solver"
    assert imported_job.recommendation_engine == "local_ev"
    assert imported_job.training_decision is None
    assert FileJobStore(target_dir).image_path(imported_job).read_bytes() == VALID_PNG


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("schema_version", True),
        ("schema_version", 1.0),
        ("case_count", "1"),
        ("case_count", 1.0),
    ],
)
def test_benchmark_dataset_import_rejects_coerced_manifest_integers(
    tmp_path: Path,
    field_name: str,
    value: object,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client).json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    with ZipFile(BytesIO(archive)) as dataset:
        manifest = json.loads(dataset.read("manifest.json"))
    manifest[field_name] = value
    modified = rebuild_zip_archive(
        archive,
        {
            "manifest.json": (
                json.dumps(manifest, indent=2) + "\n"
            ).encode(),
        },
    )
    target_dir = tmp_path / "target"
    target_client = make_client(target_dir)

    response = target_client.post(
        "/api/benchmarks/import",
        files={"file": ("coerced-manifest.zip", modified, "application/zip")},
    )

    assert response.status_code == 400
    assert f"invalid at {field_name}" in response.json()["detail"]
    assert FileJobStore(target_dir).list() == []


def test_benchmark_dataset_import_persists_request_receipt_for_recovery(
    tmp_path: Path,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client, filename="recoverable.png").json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    target_dir = tmp_path / "target"
    target_client = make_client(
        target_dir,
        recommendation_provider="local_solver",
        local_solver_engine="local_ev",
    )
    request_id = "benchmark-import-request-123"
    headers = {"X-Benchmark-Import-Request-ID": request_id}

    imported = target_client.post(
        "/api/benchmarks/import",
        headers=headers,
        files={"file": ("dataset.zip", archive, "application/zip")},
    )
    recovered = target_client.get(f"/api/benchmarks/imports/{request_id}")
    repeated = target_client.post(
        "/api/benchmarks/import",
        headers=headers,
        files={"file": ("dataset.zip", archive, "application/zip")},
    )
    missing = target_client.get("/api/benchmarks/imports/unknown-request")

    assert imported.status_code == 200
    assert imported.json() == {
        "imported_cases": 1,
        "reused_cases": 0,
        "included_cases": 1,
        "job_ids": [source_job_id],
    }
    assert recovered.status_code == 200
    assert recovered.json() == {
        "request_id": request_id,
        "archive_sha256": sha256(archive).hexdigest(),
        "status": "completed",
        "result": imported.json(),
        "error": None,
        "error_status": None,
    }
    assert repeated.status_code == 200
    assert repeated.json() == imported.json()
    imported_job = FileJobStore(target_dir).get(source_job_id)
    assert imported_job.recommendation_provider == "local_solver"
    assert imported_job.recommendation_engine == "local_ev"
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Benchmark dataset import not found"


@pytest.mark.parametrize("request_id", [".", ".."])
def test_benchmark_dataset_import_rejects_dot_segment_request_ids(
    tmp_path: Path,
    request_id: str,
) -> None:
    client = make_client(tmp_path)

    response = client.post(
        "/api/benchmarks/import",
        headers={"X-Benchmark-Import-Request-ID": request_id},
        files={"file": ("dataset.zip", b"not a zip", "application/zip")},
    )
    benchmark_store = FileBenchmarkStore(tmp_path)

    assert response.status_code == 422
    assert list(benchmark_store.imports_dir.iterdir()) == []
    with pytest.raises(BenchmarkImportNotFoundError):
        benchmark_store.begin_import(request_id, b"dataset")


def test_benchmark_dataset_import_blocks_runs_until_partial_case_recovers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client, filename="interrupted.png").json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    target_dir = tmp_path / "target"
    target_client = make_client(target_dir)
    request_id = "interrupted-import-request"
    original_write_image = FileJobStore.write_image
    interrupted = False

    def interrupt_first_import_image(
        self: FileJobStore,
        job,
        image_bytes: bytes,
    ) -> None:
        nonlocal interrupted
        if (
            not interrupted
            and job.benchmark_import_request_id == request_id
        ):
            interrupted = True
            raise OSError("simulated process interruption")
        original_write_image(self, job, image_bytes)

    monkeypatch.setattr(FileJobStore, "write_image", interrupt_first_import_image)
    with pytest.raises(OSError, match="simulated process interruption"):
        target_client.post(
            "/api/benchmarks/import",
            headers={"X-Benchmark-Import-Request-ID": request_id},
            files={"file": ("dataset.zip", archive, "application/zip")},
        )

    interrupted_store = FileJobStore(target_dir)
    partial_job = interrupted_store.get(source_job_id)
    assert partial_job.benchmark_import_request_id == request_id
    assert not interrupted_store.image_path(partial_job).exists()
    assert FileBenchmarkStore(target_dir).get_import(request_id).status == "pending"

    monkeypatch.setattr(FileJobStore, "write_image", original_write_image)
    recovery_client = make_client(target_dir)
    blocked_run = recovery_client.post("/api/benchmarks/run")
    blocked_export = recovery_client.get("/api/benchmarks/export")
    blocked_inclusion = recovery_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": False},
    )
    blocked_import = recovery_client.post(
        "/api/benchmarks/import",
        headers={"X-Benchmark-Import-Request-ID": "second-pending-import"},
        files={"file": ("dataset.zip", archive, "application/zip")},
    )

    assert blocked_run.status_code == 409
    assert blocked_run.json()["detail"] == "A benchmark dataset import is still pending"
    assert blocked_export.status_code == 409
    assert blocked_export.json()["detail"] == "A benchmark dataset import is still pending"
    assert blocked_inclusion.status_code == 409
    assert blocked_inclusion.json()["detail"] == (
        "A benchmark dataset import is still pending"
    )
    assert blocked_import.status_code == 409
    assert blocked_import.json()["detail"] == (
        "A benchmark dataset import is still pending"
    )
    with pytest.raises(BenchmarkImportNotFoundError):
        FileBenchmarkStore(target_dir).get_import("second-pending-import")
    assert FileBenchmarkStore(target_dir).get_latest() is None

    pending = recovery_client.get(f"/api/benchmarks/imports/{request_id}")
    completed = recovery_client.get(f"/api/benchmarks/imports/{request_id}")
    recovered_run = recovery_client.post("/api/benchmarks/run")

    assert pending.status_code == 200
    assert pending.json()["status"] == "pending"
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["result"] == {
        "imported_cases": 1,
        "reused_cases": 0,
        "included_cases": 1,
        "job_ids": [source_job_id],
    }
    assert recovered_run.status_code == 200
    assert recovered_run.json()["total_cases"] == 1
    assert recovered_run.json()["cases"][0]["job_id"] == source_job_id
    recovered_job = FileJobStore(target_dir).get(source_job_id)
    assert FileJobStore(target_dir).image_path(recovered_job).read_bytes() == VALID_PNG


def test_benchmark_dataset_import_journals_before_parsing_and_resumes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client, filename="parse-interrupted.png").json()[
        "id"
    ]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    target_dir = tmp_path / "target"
    target_client = make_client(target_dir)
    request_id = "parse-interrupted-import"
    parse_entered = Event()
    release_parse = Event()
    import_errors: list[Exception] = []
    original_parse = api_module.parse_parser_dataset_archive

    def interrupt_parse(*args: object, **kwargs: object):
        parse_entered.set()
        assert release_parse.wait(timeout=2)
        raise OSError("simulated interruption during dataset parsing")

    monkeypatch.setattr(api_module, "parse_parser_dataset_archive", interrupt_parse)

    def run_import() -> None:
        try:
            target_client.post(
                "/api/benchmarks/import",
                headers={"X-Benchmark-Import-Request-ID": request_id},
                files={"file": ("dataset.zip", archive, "application/zip")},
            )
        except Exception as exc:
            import_errors.append(exc)

    import_thread = Thread(target=run_import)
    import_thread.start()
    assert parse_entered.wait(timeout=2)

    benchmark_store = FileBenchmarkStore(target_dir)
    assert benchmark_store.get_import(request_id).status == "pending"
    assert benchmark_store.get_import_archive(request_id) == archive

    release_parse.set()
    import_thread.join(timeout=2)
    assert not import_thread.is_alive()
    assert len(import_errors) == 1
    assert isinstance(import_errors[0], OSError)

    monkeypatch.setattr(
        api_module,
        "parse_parser_dataset_archive",
        original_parse,
    )
    recovery_client = make_client(target_dir)
    pending = recovery_client.get(f"/api/benchmarks/imports/{request_id}")
    completed = recovery_client.get(f"/api/benchmarks/imports/{request_id}")

    assert pending.status_code == 200
    assert pending.json()["status"] == "pending"
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    assert completed.json()["result"]["job_ids"] == [source_job_id]


def test_benchmark_dataset_import_persists_validation_failure_receipt(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)
    request_id = "invalid-archive-import"

    response = client.post(
        "/api/benchmarks/import",
        headers={"X-Benchmark-Import-Request-ID": request_id},
        files={"file": ("dataset.zip", b"not a zip", "application/zip")},
    )
    receipt = client.get(f"/api/benchmarks/imports/{request_id}")
    repeated = client.post(
        "/api/benchmarks/import",
        headers={"X-Benchmark-Import-Request-ID": request_id},
        files={"file": ("dataset.zip", b"not a zip", "application/zip")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Upload must be a valid dataset ZIP"
    assert receipt.status_code == 200
    assert receipt.json() == {
        "request_id": request_id,
        "archive_sha256": sha256(b"not a zip").hexdigest(),
        "status": "failed",
        "result": None,
        "error": "Upload must be a valid dataset ZIP",
        "error_status": 400,
    }
    assert repeated.status_code == 400
    assert repeated.json()["detail"] == "Upload must be a valid dataset ZIP"


def test_benchmark_dataset_import_rejects_unsupported_compression(
    tmp_path: Path,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client).json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    unsupported_archive = archive_with_unsupported_compression(archive)

    response = make_client(tmp_path / "target").post(
        "/api/benchmarks/import",
        files={
            "file": (
                "unsupported.zip",
                unsupported_archive,
                "application/zip",
            ),
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Dataset ZIP uses an unsupported compression method"
    )


def test_benchmark_import_recovery_fails_unsupported_compression_receipt(
    tmp_path: Path,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(source_client).json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content
    unsupported_archive = archive_with_unsupported_compression(archive)

    target_dir = tmp_path / "target"
    target_client = make_client(target_dir)
    existing_job_id = upload_job(target_client).json()["id"]
    approve_job(target_client, existing_job_id)
    target_client.put(
        f"/api/jobs/{existing_job_id}/benchmark",
        json={"included": True},
    )
    request_id = "unsupported-compression-import"
    benchmark_store = FileBenchmarkStore(target_dir)
    benchmark_store.begin_import(request_id, unsupported_archive)

    recovery_client = make_client(target_dir)
    pending = recovery_client.get(f"/api/benchmarks/imports/{request_id}")
    failed = recovery_client.get(f"/api/benchmarks/imports/{request_id}")
    recovered_run = recovery_client.post("/api/benchmarks/run")

    assert pending.status_code == 200
    assert pending.json()["status"] == "pending"
    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"
    assert failed.json()["error"] == (
        "Dataset ZIP uses an unsupported compression method"
    )
    assert failed.json()["error_status"] == 400
    with pytest.raises(BenchmarkImportNotFoundError):
        benchmark_store.get_import_archive(request_id)
    assert recovered_run.status_code == 200
    assert recovered_run.json()["total_cases"] == 1
    assert recovered_run.json()["cases"][0]["job_id"] == existing_job_id


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


def test_benchmark_run_waits_for_dataset_import_corpus_update(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_client = make_client(tmp_path / "source")
    source_job_id = upload_job(
        source_client,
        filename="imported-during-run.png",
    ).json()["id"]
    approve_job(source_client, source_job_id)
    source_client.put(
        f"/api/jobs/{source_job_id}/benchmark",
        json={"included": True},
    )
    archive = source_client.get("/api/benchmarks/export").content

    target_client = make_client(tmp_path / "target")
    target_job_id = upload_job(
        target_client,
        filename="existing-before-run.png",
    ).json()["id"]
    approve_job(target_client, target_job_id)
    target_client.put(
        f"/api/jobs/{target_job_id}/benchmark",
        json={"included": True},
    )

    import_entered = Event()
    release_import = Event()
    benchmark_started = Event()
    benchmark_finished = Event()
    responses: dict[str, object] = {}
    original_import = api_module.import_parser_dataset

    def paused_import(*args: object, **kwargs: object):
        import_entered.set()
        assert release_import.wait(timeout=2)
        return original_import(*args, **kwargs)

    monkeypatch.setattr(api_module, "import_parser_dataset", paused_import)

    import_thread = Thread(
        target=lambda: responses.update(
            imported=target_client.post(
                "/api/benchmarks/import",
                files={"file": ("dataset.zip", archive, "application/zip")},
            ),
        ),
    )

    def run_benchmark_request() -> None:
        benchmark_started.set()
        responses["benchmark"] = target_client.post("/api/benchmarks/run")
        benchmark_finished.set()

    benchmark_thread = Thread(target=run_benchmark_request)
    import_thread.start()
    try:
        assert import_entered.wait(timeout=2)
        benchmark_thread.start()
        assert benchmark_started.wait(timeout=2)
        assert not benchmark_finished.wait(timeout=0.1)
    finally:
        release_import.set()
        import_thread.join(timeout=2)
        benchmark_thread.join(timeout=2)

    assert not import_thread.is_alive()
    assert not benchmark_thread.is_alive()
    assert responses["imported"].status_code == 200
    assert responses["benchmark"].status_code == 200
    assert responses["benchmark"].json()["total_cases"] == 2
    assert {
        case["job_id"] for case in responses["benchmark"].json()["cases"]
    } == {target_job_id, source_job_id}


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
