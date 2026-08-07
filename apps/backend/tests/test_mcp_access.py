from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings
from app.mcp_access import McpPrincipalStore


def test_principal_store_issues_once_rotates_and_revokes(tmp_path: Path) -> None:
    store = McpPrincipalStore(tmp_path, "staging")
    issued = store.create(
        name="Codex staging read",
        scopes=["read"],
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )

    assert issued.token.startswith("phmcp_")
    assert store.authenticate(issued.token) is not None
    serialized = (tmp_path / "mcp" / "principals.json").read_text(encoding="utf-8")
    assert issued.token not in serialized
    assert issued.principal.token_prefix in serialized

    rotated = store.rotate(issued.principal.id)
    assert rotated.token != issued.token
    assert store.authenticate(issued.token) is None
    assert store.authenticate(rotated.token) is not None

    revoked = store.revoke(issued.principal.id)
    assert revoked.status == "revoked"
    assert store.authenticate(rotated.token) is None


def test_principal_store_binds_credentials_to_environment(tmp_path: Path) -> None:
    staging = McpPrincipalStore(tmp_path, "staging")
    production = McpPrincipalStore(tmp_path, "production")
    issued = staging.create(
        name="Codex staging",
        scopes=["read"],
        expires_at=None,
    )

    assert staging.authenticate(issued.token) is not None
    assert production.authenticate(issued.token) is None
    assert production.list() == []


def test_hosted_mcp_is_dark_by_default(tmp_path: Path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                deployment_environment="staging",
                api_rate_limit_enabled=False,
            )
        ),
        base_url="https://poker.test",
    )

    assert client.post("/mcp", json={}).status_code == 404
    assert client.get("/api/mcp/config").json() == {
        "enabled": False,
        "environment": "staging",
        "endpoint": None,
        "writes_enabled": False,
    }


def test_production_rejects_write_credentials(tmp_path: Path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                deployment_environment="production",
                api_rate_limit_enabled=False,
            )
        ),
        base_url="https://poker.test",
    )

    rejected = client.post(
        "/api/mcp/principals",
        json={
            "name": "Codex production",
            "scopes": ["read", "write"],
            "expires_at": None,
        },
    )

    assert rejected.status_code == 400
    assert rejected.json()["detail"] == (
        "MCP write credentials can only be issued in staging"
    )


def test_hosted_mcp_requires_an_environment_token(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        deployment_environment="staging",
        mcp_enabled=True,
        mcp_public_url="https://poker.test/mcp",
        api_rate_limit_enabled=False,
    )
    with TestClient(create_app(settings), base_url="https://poker.test") as client:
        missing = client.post("/mcp", json=_initialize_request())
        assert missing.status_code == 401
        assert missing.headers["www-authenticate"] == "Bearer"
        assert missing.headers["cache-control"] == "no-store"

        issued = client.post(
            "/api/mcp/principals",
            json={"name": "Codex staging", "scopes": ["read"], "expires_at": None},
        )
        assert issued.status_code == 201
        token = issued.json()["token"]
        assert token.startswith("phmcp_")
        assert issued.headers["cache-control"] == "no-store"

        initialized = client.post(
            "/mcp",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
            },
            json=_initialize_request(),
        )
        assert initialized.status_code == 200
        assert initialized.headers["cache-control"] == "no-store"
        assert initialized.json()["result"]["serverInfo"]["name"] == "Poker Hero staging"

        tools = client.post(
            "/mcp",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
            },
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        assert tools.status_code == 200
        assert {tool["name"] for tool in tools.json()["result"]["tools"]} == {
            "get_environment_status",
            "list_processing_jobs",
            "get_job",
            "search_history",
            "get_training_progress",
            "list_benchmarks",
        }

        revoked = client.delete(
            f"/api/mcp/principals/{issued.json()['principal']['id']}"
        )
        assert revoked.status_code == 200
        assert revoked.json()["status"] == "revoked"
        denied = client.post(
            "/mcp",
            headers={"Authorization": f"Bearer {token}"},
            json=_initialize_request(),
        )
        assert denied.status_code == 401


def test_hosted_mcp_requires_scope_and_omits_local_upload(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        deployment_environment="staging",
        mcp_enabled=True,
        mcp_public_url="https://poker.test/mcp",
        mcp_allow_writes=True,
        api_rate_limit_enabled=False,
    )
    with TestClient(create_app(settings), base_url="https://poker.test") as client:
        issued = client.post(
            "/api/mcp/principals",
            json={"name": "Read-only Codex", "scopes": ["read"], "expires_at": None},
        ).json()
        token = issued["token"]
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        }
        tools = client.post(
            "/mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        ).json()["result"]["tools"]
        names = {tool["name"] for tool in tools}
        assert "save_training_review" in names
        assert "submit_screenshot" not in names

        denied = client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "save_training_review",
                    "arguments": {"job_id": "0" * 32, "note": "review"},
                },
            },
        )
        assert denied.status_code == 200
        assert denied.json()["result"]["isError"] is True
        assert "does not grant write access" in denied.json()["result"]["content"][0]["text"]


def test_hosted_mcp_rate_limits_each_principal(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        deployment_environment="staging",
        mcp_enabled=True,
        mcp_public_url="https://poker.test/mcp",
        mcp_read_calls_per_minute=1,
        api_rate_limit_enabled=False,
    )
    with TestClient(create_app(settings), base_url="https://poker.test") as client:
        token = client.post(
            "/api/mcp/principals",
            json={"name": "Limited Codex", "scopes": ["read"], "expires_at": None},
        ).json()["token"]
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        }
        assert client.post(
            "/mcp", headers=headers, json=_initialize_request()
        ).status_code == 200
        limited = client.post(
            "/mcp", headers=headers, json=_initialize_request()
        )
        assert limited.status_code == 429
        assert limited.headers["retry-after"]


def _initialize_request() -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "poker-tests", "version": "1.0"},
        },
    }
