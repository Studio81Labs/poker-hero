from __future__ import annotations

from typing import Any
from uuid import UUID

import sentry_sdk

from app.config import Settings

_monitoring_enabled = False
_ALLOWED_EVENT_FIELDS = {
    "dist",
    "environment",
    "event_id",
    "exception",
    "level",
    "platform",
    "release",
    "tags",
    "timestamp",
}
_ALLOWED_TAGS = {
    "component",
    "http_method",
    "http_route",
    "request_id",
    "source",
}
_ALLOWED_EXCEPTION_FIELDS = {"mechanism", "stacktrace", "type", "value"}
_ALLOWED_MECHANISM_FIELDS = {"handled", "synthetic", "type"}
_ALLOWED_STACKTRACE_FIELDS = {"frames", "frames_omitted"}
_ALLOWED_FRAME_FIELDS = {
    "colno",
    "filename",
    "function",
    "in_app",
    "instruction_addr",
    "lineno",
    "module",
    "symbol_addr",
}


def configure_error_monitoring(settings: Settings) -> bool:
    """Configure sanitized exception reporting when a Sentry DSN is present."""

    global _monitoring_enabled
    _monitoring_enabled = False
    if settings.sentry_dsn is None:
        return False

    try:
        sentry_sdk.init(
            dsn=settings.sentry_dsn.get_secret_value(),
            environment=settings.sentry_environment,
            release=settings.sentry_release,
            sample_rate=settings.sentry_error_sample_rate,
            traces_sample_rate=0.0,
            send_default_pii=False,
            max_request_body_size="never",
            default_integrations=False,
            before_send=_scrub_event,
        )
    except Exception:
        return False
    _monitoring_enabled = True
    return True


def capture_unhandled_exception(
    error: Exception,
    *,
    request_id: str | None = None,
    method: str | None = None,
    route: str | None = None,
) -> str | None:
    """Report an unhandled failure without affecting the application response."""

    if not _monitoring_enabled:
        return None
    try:
        with sentry_sdk.new_scope() as scope:
            scope.set_tag("component", "backend")
            opaque_request_id = _opaque_request_id(request_id)
            if opaque_request_id is not None:
                scope.set_tag("request_id", opaque_request_id)
            if method:
                scope.set_tag("http_method", method)
            if route:
                scope.set_tag("http_route", route)
                scope.set_transaction_name(f"{method or 'REQUEST'} {route}")
            return sentry_sdk.capture_exception(error, scope=scope)
    except Exception:
        return None


def route_template(scope: dict[str, Any]) -> str | None:
    route = scope.get("route")
    route_path = getattr(route, "path", None)
    if isinstance(route_path, str) and route_path.startswith("/"):
        return route_path
    return None


def _opaque_request_id(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        parsed = UUID(value)
    except (AttributeError, ValueError):
        return None
    normalized = value.lower()
    if parsed.version != 4 or normalized not in {parsed.hex, str(parsed)}:
        return None
    return normalized


def _scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    sanitized = event
    _retain_fields(sanitized, _ALLOWED_EVENT_FIELDS)

    tags = sanitized.get("tags")
    if isinstance(tags, dict):
        _retain_fields(tags, _ALLOWED_TAGS)
    else:
        sanitized.pop("tags", None)

    exception = sanitized.get("exception")
    if isinstance(exception, dict):
        _retain_fields(exception, {"values"})
        values = exception.get("values")
        if isinstance(values, list):
            for value in values:
                if not isinstance(value, dict):
                    continue
                _retain_fields(value, _ALLOWED_EXCEPTION_FIELDS)
                value["value"] = "Exception details redacted"
                mechanism = value.get("mechanism")
                if isinstance(mechanism, dict):
                    _retain_fields(mechanism, _ALLOWED_MECHANISM_FIELDS)
                stacktrace = value.get("stacktrace")
                if not isinstance(stacktrace, dict):
                    continue
                _retain_fields(stacktrace, _ALLOWED_STACKTRACE_FIELDS)
                frames = stacktrace.get("frames")
                if not isinstance(frames, list):
                    continue
                for frame in frames:
                    if isinstance(frame, dict):
                        _retain_fields(frame, _ALLOWED_FRAME_FIELDS)
    else:
        sanitized.pop("exception", None)
    return sanitized


def _retain_fields(value: dict[str, Any], allowed: set[str]) -> None:
    for key in tuple(value):
        if key not in allowed:
            value.pop(key, None)
