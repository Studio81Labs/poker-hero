from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app import error_monitoring
from app.config import Settings


def test_monitoring_is_disabled_without_a_dsn(
    tmp_path: Path,
    monkeypatch,
) -> None:
    initialized = False

    def fake_init(**_kwargs: object) -> None:
        nonlocal initialized
        initialized = True

    monkeypatch.setattr(error_monitoring.sentry_sdk, "init", fake_init)

    assert error_monitoring.configure_error_monitoring(
        Settings(data_dir=tmp_path)
    ) is False
    assert initialized is False


def test_monitoring_initializes_with_privacy_safe_options(
    tmp_path: Path,
    monkeypatch,
) -> None:
    options: dict[str, object] = {}
    monkeypatch.setattr(
        error_monitoring.sentry_sdk,
        "init",
        lambda **kwargs: options.update(kwargs),
    )

    enabled = error_monitoring.configure_error_monitoring(
        Settings(
            data_dir=tmp_path,
            sentry_dsn="https://public@example.ingest.sentry.io/123",
            sentry_environment="testing",
            sentry_release="poker-hero@abc123",
            sentry_error_sample_rate=0.5,
        )
    )

    assert enabled is True
    assert options["dsn"] == "https://public@example.ingest.sentry.io/123"
    assert options["environment"] == "testing"
    assert options["release"] == "poker-hero@abc123"
    assert options["sample_rate"] == 0.5
    assert options["traces_sample_rate"] == 0
    assert options["send_default_pii"] is False
    assert options["max_request_body_size"] == "never"
    assert options["default_integrations"] is False
    assert options["before_send"] is error_monitoring._scrub_event


def test_monitoring_initialization_failure_leaves_adapter_disabled(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(error_monitoring, "_monitoring_enabled", True)

    def fail_init(**_kwargs: object) -> None:
        raise ValueError("invalid provider configuration")

    monkeypatch.setattr(error_monitoring.sentry_sdk, "init", fail_init)

    enabled = error_monitoring.configure_error_monitoring(
        Settings(
            data_dir=tmp_path,
            sentry_dsn="https://public@example.ingest.sentry.io/123",
        )
    )

    assert enabled is False
    assert error_monitoring.capture_unhandled_exception(
        RuntimeError("application failed")
    ) is None


def test_scrub_event_removes_request_and_exception_data() -> None:
    original = {
        "breadcrumbs": {"values": [{"message": "Uploaded AhKd"}]},
        "contexts": {"runtime": {"name": "CPython"}},
        "extra": {"approved_state": {"hero_cards": ["Ah", "Kd"]}},
        "logentry": {"message": "private provider output"},
        "message": "private provider output",
        "request": {
            "cookies": {"session": "secret"},
            "data": "binary screenshot",
            "headers": {"authorization": "Bearer secret"},
            "method": "POST",
            "query_string": "search=player-name",
            "url": "https://api.example.com/api/jobs/abc?search=player-name#fragment",
        },
        "server_name": "private-host",
        "user": {"email": "player@example.com"},
        "future_sdk_field": {"cards": ["Ah", "Kd"]},
        "exception": {
            "values": [
                {
                    "type": "RuntimeError",
                    "value": "solver failed for AhKd",
                    "future_exception_field": "private provider output",
                    "mechanism": {"type": "generic", "data": {"private": True}},
                    "stacktrace": {
                        "frames": [
                            {
                                "filename": "app/api.py",
                                "abs_path": "/private/server/app/api.py",
                                "lineno": 10,
                                "vars": {"hero_cards": ["Ah", "Kd"]},
                                "context_line": "raise RuntimeError(hero_cards)",
                            }
                        ]
                    },
                }
            ]
        },
        "tags": {
            "request_id": "request-123",
            "future_private_tag": "player-name",
        },
    }

    sanitized = error_monitoring._scrub_event(original, {})

    for field in (
        "breadcrumbs",
        "contexts",
        "extra",
        "logentry",
        "message",
        "request",
        "server_name",
        "user",
        "future_sdk_field",
    ):
        assert field not in sanitized
    exception = sanitized["exception"]["values"][0]
    assert exception["value"] == "Exception details redacted"
    assert "data" not in exception["mechanism"]
    assert "vars" not in exception["stacktrace"]["frames"][0]
    assert "abs_path" not in exception["stacktrace"]["frames"][0]
    assert "context_line" not in exception["stacktrace"]["frames"][0]
    assert "future_exception_field" not in exception
    assert sanitized["tags"] == {"request_id": "request-123"}


def test_capture_failure_never_escapes(
    monkeypatch,
) -> None:
    monkeypatch.setattr(error_monitoring, "_monitoring_enabled", True)

    @contextmanager
    def broken_scope() -> Iterator[None]:
        raise RuntimeError("monitor unavailable")
        yield

    monkeypatch.setattr(error_monitoring.sentry_sdk, "new_scope", broken_scope)

    assert error_monitoring.capture_unhandled_exception(
        RuntimeError("application failed"),
        request_id="request-123",
    ) is None


def test_route_template_never_falls_back_to_a_caller_path() -> None:
    class Route:
        path = "/api/jobs/{job_id}/recommendation"

    assert error_monitoring.route_template({"route": Route()}) == (
        "/api/jobs/{job_id}/recommendation"
    )
    assert error_monitoring.route_template({"path": "/private-player-name"}) is None


def test_capture_tags_the_request_without_attaching_state(monkeypatch) -> None:
    class FakeScope:
        def __init__(self) -> None:
            self.tags: dict[str, str] = {}
            self.transaction_name: str | None = None

        def set_tag(self, key: str, value: str) -> None:
            self.tags[key] = value

        def set_transaction_name(self, value: str) -> None:
            self.transaction_name = value

    scope = FakeScope()

    @contextmanager
    def fake_scope() -> Iterator[FakeScope]:
        yield scope

    captured: dict[str, object] = {}

    def fake_capture(error: Exception, *, scope: FakeScope) -> str:
        captured.update(error=error, scope=scope)
        return "event-id"

    monkeypatch.setattr(error_monitoring, "_monitoring_enabled", True)
    monkeypatch.setattr(error_monitoring.sentry_sdk, "new_scope", fake_scope)
    monkeypatch.setattr(
        error_monitoring.sentry_sdk,
        "capture_exception",
        fake_capture,
    )
    error = RuntimeError("application failed")
    request_id = "08b8ce83-8423-4fe6-8aa1-966d6710ad74"

    event_id = error_monitoring.capture_unhandled_exception(
        error,
        request_id=request_id,
        method="POST",
        route="/api/jobs/{job_id}/recommendation",
    )

    assert event_id == "event-id"
    assert captured == {"error": error, "scope": scope}
    assert scope.tags == {
        "component": "backend",
        "request_id": request_id,
        "http_method": "POST",
        "http_route": "/api/jobs/{job_id}/recommendation",
    }
    assert scope.transaction_name == "POST /api/jobs/{job_id}/recommendation"


def test_capture_drops_caller_controlled_nonopaque_request_id(monkeypatch) -> None:
    class FakeScope:
        def __init__(self) -> None:
            self.tags: dict[str, str] = {}

        def set_tag(self, key: str, value: str) -> None:
            self.tags[key] = value

        def set_transaction_name(self, _value: str) -> None:
            pass

    scope = FakeScope()

    @contextmanager
    def fake_scope() -> Iterator[FakeScope]:
        yield scope

    monkeypatch.setattr(error_monitoring, "_monitoring_enabled", True)
    monkeypatch.setattr(error_monitoring.sentry_sdk, "new_scope", fake_scope)
    monkeypatch.setattr(
        error_monitoring.sentry_sdk,
        "capture_exception",
        lambda _error, *, scope: "event-id",
    )

    error_monitoring.capture_unhandled_exception(
        RuntimeError("application failed"),
        request_id="AhKd-player-name",
        method="POST",
        route="/api/jobs",
    )

    assert scope.tags == {
        "component": "backend",
        "http_method": "POST",
        "http_route": "/api/jobs",
    }
