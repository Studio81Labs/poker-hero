import base64
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api import PROXY_SHARED_SECRET_HEADER, create_app
from app.config import Settings
from app.rate_limiting import (
    ACCESS_USER_HEADER,
    CONNECTING_IP_HEADER,
    ApiRateLimiter,
    RateLimitCategory,
    rate_limit_category,
    request_rate_limit_identity,
)


VALID_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=="
)
PROXY_SECRET = "worker-to-backend-secret-value-123"


def make_client(tmp_path: Path, **overrides: object) -> TestClient:
    values: dict[str, object] = {
        "data_dir": tmp_path,
        "parser_provider": "mock",
        "recommendation_provider": "mock",
        "api_rate_limit_uploads_per_minute": 1,
    }
    values.update(overrides)
    return TestClient(create_app(Settings(**values)))


def upload(client: TestClient, *, headers: dict[str, str] | None = None):
    return client.post(
        "/api/jobs",
        files={"file": ("table.png", VALID_PNG, "image/png")},
        headers=headers,
    )


def identities_for_headers(
    headers: dict[str, str],
    *,
    client_host: str = "127.0.0.1",
) -> tuple[str, str]:
    app = FastAPI()

    @app.get("/")
    def read_identity(request: Request) -> dict[str, str]:
        return {
            "proxy": request_rate_limit_identity(
                request,
                trust_proxy_headers=True,
            ),
            "direct": request_rate_limit_identity(
                request,
                trust_proxy_headers=False,
            ),
        }

    client = TestClient(app, client=(client_host, 50000))
    response = client.get("/", headers=headers)
    response.raise_for_status()
    payload = response.json()
    return payload["proxy"], payload["direct"]


def test_token_bucket_rejects_until_a_token_is_replenished() -> None:
    now = [100.0]
    limiter = ApiRateLimiter(
        {
            "uploads": 2,
            "recommendations": 2,
            "benchmarks": 2,
            "data_transfers": 2,
        },
        clock=lambda: now[0],
    )

    first = limiter.check("uploads", "client-a")
    second = limiter.check("uploads", "client-a")
    rejected = limiter.check("uploads", "client-a")

    assert (first.allowed, first.remaining) == (True, 1)
    assert (second.allowed, second.remaining) == (True, 0)
    assert rejected.allowed is False
    assert rejected.retry_after_seconds == 30

    now[0] += 30
    replenished = limiter.check("uploads", "client-a")
    assert replenished.allowed is True
    assert replenished.remaining == 0


def test_token_buckets_are_independent_by_category_and_identity() -> None:
    limiter = ApiRateLimiter(
        {
            "uploads": 1,
            "recommendations": 1,
            "benchmarks": 1,
            "data_transfers": 1,
        }
    )

    assert limiter.check("uploads", "client-a").allowed is True
    assert limiter.check("uploads", "client-a").allowed is False
    assert limiter.check("recommendations", "client-a").allowed is True
    assert limiter.check("uploads", "client-b").allowed is True


def test_limiter_requires_a_complete_positive_policy() -> None:
    partial_policy: dict[RateLimitCategory, int] = {"uploads": 1}
    with pytest.raises(ValueError, match="every rate-limit category"):
        ApiRateLimiter(partial_policy)
    with pytest.raises(ValueError, match="must be positive"):
        ApiRateLimiter(
            {
                "uploads": 0,
                "recommendations": 1,
                "benchmarks": 1,
                "data_transfers": 1,
            }
        )


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("POST", "/api/jobs", "uploads"),
        ("post", "/api/jobs/job-1/recommend", "recommendations"),
        ("POST", "/api/benchmarks/run", "benchmarks"),
        ("GET", "/api/backups/export", "data_transfers"),
        ("POST", "/api/backups/restore", "data_transfers"),
        ("GET", "/api/benchmarks/export", "data_transfers"),
        ("POST", "/api/benchmarks/import", "data_transfers"),
        ("GET", "/api/health", None),
        ("POST", "/api/jobs/job-1/approve", None),
        ("POST", "/api/jobs/job-1/recommend/extra", None),
    ],
)
def test_rate_limit_category_matches_only_expensive_routes(
    method: str,
    path: str,
    expected: str | None,
) -> None:
    assert rate_limit_category(method, path) == expected


def test_proxy_identity_prefers_a_private_access_user_digest() -> None:
    first_proxy, first_direct = identities_for_headers(
        {
            ACCESS_USER_HEADER: " Player@Example.com ",
            CONNECTING_IP_HEADER: "203.0.113.10",
        }
    )
    same_user_proxy, _ = identities_for_headers(
        {
            ACCESS_USER_HEADER: "player@example.com",
            CONNECTING_IP_HEADER: "203.0.113.11",
        }
    )

    assert first_proxy == same_user_proxy
    assert first_proxy != first_direct
    assert "player@example.com" not in first_proxy


def test_proxy_identity_uses_validated_ip_then_a_shared_fallback() -> None:
    valid_proxy, _ = identities_for_headers(
        {CONNECTING_IP_HEADER: "2001:db8::1"}
    )
    invalid_proxy, _ = identities_for_headers(
        {CONNECTING_IP_HEADER: "not-an-ip"}
    )
    missing_proxy, _ = identities_for_headers({})

    assert valid_proxy != missing_proxy
    assert invalid_proxy == missing_proxy


def test_upload_rate_limit_returns_retry_metadata_and_cors_headers(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path)

    first = upload(client)
    rejected = client.post(
        "/api/jobs",
        files={"file": ("table.png", VALID_PNG, "image/png")},
        headers={"Origin": "http://localhost:5173"},
    )

    assert first.status_code == 201
    assert first.headers["x-ratelimit-limit"] == "1"
    assert first.headers["x-ratelimit-remaining"] == "0"
    assert rejected.status_code == 429
    assert rejected.json() == {
        "detail": "Rate limit exceeded for uploads",
        "retry_after_seconds": 60,
    }
    assert rejected.headers["retry-after"] == "60"
    exposed = rejected.headers["access-control-expose-headers"].lower()
    assert "retry-after" in exposed
    assert "x-ratelimit-remaining" in exposed


def test_unauthorized_request_does_not_consume_authenticated_budget(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path, proxy_shared_secret=PROXY_SECRET)

    unauthorized = upload(client)
    authorized = upload(
        client,
        headers={PROXY_SHARED_SECRET_HEADER: PROXY_SECRET},
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 201


def test_access_users_receive_independent_budgets(tmp_path: Path) -> None:
    client = make_client(tmp_path, proxy_shared_secret=PROXY_SECRET)
    first_user = {
        PROXY_SHARED_SECRET_HEADER: PROXY_SECRET,
        ACCESS_USER_HEADER: "first@example.com",
    }
    second_user = {
        PROXY_SHARED_SECRET_HEADER: PROXY_SECRET,
        ACCESS_USER_HEADER: "second@example.com",
    }

    assert upload(client, headers=first_user).status_code == 201
    assert upload(client, headers=first_user).status_code == 429
    assert upload(client, headers=second_user).status_code == 201


def test_rate_limiting_can_be_disabled_for_trusted_local_workflows(
    tmp_path: Path,
) -> None:
    client = make_client(tmp_path, api_rate_limit_enabled=False)

    assert upload(client).status_code == 201
    assert upload(client).status_code == 201
