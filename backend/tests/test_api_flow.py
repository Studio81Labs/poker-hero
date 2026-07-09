from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import Settings


def make_client(tmp_path: Path) -> TestClient:
    app = create_app(Settings(data_dir=tmp_path, parser_provider="mock", recommendation_provider="mock"))
    return TestClient(app)


def test_upload_parse_approve_and_recommend(tmp_path: Path) -> None:
    client = make_client(tmp_path)

    upload = client.post(
        "/api/jobs",
        files={"file": ("table.png", b"not a real image but accepted for mock parser", "image/png")},
    )

    assert upload.status_code == 200
    job = upload.json()
    assert job["status"] == "parsed"
    assert job["parser_result"]["state"]["hero_cards"][0]["rank"] == "A"
    assert job["parser_result"]["confidences"]["hero_cards"] == 0.99

    approve = client.post(
        f"/api/jobs/{job['id']}/approve",
        json={
            "hero_cards": [{"rank": "A", "suit": "hearts"}, {"rank": "K", "suit": "diamonds"}],
            "board_cards": [
                {"rank": "Q", "suit": "spades"},
                {"rank": "J", "suit": "clubs"},
                {"rank": "2", "suit": "hearts"},
            ],
            "pot_size": 12.5,
            "current_bet": 2.5,
            "effective_stack": 96.0,
            "players_in_hand": 3,
            "hero_position": "button",
            "street": "flop",
            "action_context": "Cutoff bet 2.5 into 12.5",
            "user_approved": True,
        },
    )

    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    recommend = client.post(f"/api/jobs/{job['id']}/recommend")

    assert recommend.status_code == 200
    result = recommend.json()
    assert result["status"] == "recommended"
    assert result["recommendation"]["action"] == "raise"
    assert result["recommendation"]["sizing"] == 7.5


def test_recommend_requires_approval(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    upload = client.post(
        "/api/jobs",
        files={"file": ("table.png", b"image", "image/png")},
    )
    job_id = upload.json()["id"]

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 409
    assert response.json()["detail"] == "Approve corrected state before requesting recommendation"


def test_job_image_endpoint_returns_upload(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    upload = client.post(
        "/api/jobs",
        files={"file": ("table.png", b"image-bytes", "image/png")},
    )
    job_id = upload.json()["id"]

    image_response = client.get(f"/api/jobs/{job_id}/image")

    assert image_response.status_code == 200
    assert image_response.content == b"image-bytes"


def test_provider_configuration_errors_are_http_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MisconfiguredProvider:
        name = "misconfigured"
        required_fields = ["missing_field"]

    client = make_client(tmp_path)
    upload = client.post(
        "/api/jobs",
        files={"file": ("table.png", b"image", "image/png")},
    )
    job_id = upload.json()["id"]
    client.post(
        f"/api/jobs/{job_id}/approve",
        json={
            "hero_cards": [{"rank": "A", "suit": "hearts"}, {"rank": "K", "suit": "diamonds"}],
            "street": "flop",
            "user_approved": True,
        },
    )
    monkeypatch.setattr("app.api.build_provider", lambda settings: MisconfiguredProvider())

    response = client.post(f"/api/jobs/{job_id}/recommend")

    assert response.status_code == 500
    assert response.json()["detail"] == "Provider configuration error: Unknown required field: missing_field"
