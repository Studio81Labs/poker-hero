from pathlib import Path
from typing import BinaryIO

import httpx
import pytest

from app.config import Settings
from app.parsers.base import ParserConfigurationError, ParserError
from app.parsers.registry import build_parser


def test_registry_builds_mock_parser(tmp_path: Path) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    parser = build_parser(Settings(data_dir=tmp_path, parser_provider="mock"))

    result = parser.parse(image_path)

    assert result.state.hero_cards[0].code == "Ah"
    assert result.state.hero_cards[1].code == "Kd"
    assert result.state.street == "flop"
    assert result.confidences["hero_cards"] == 0.99
    assert result.raw["provider"] == "mock"


def test_registry_rejects_unknown_parser(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, parser_provider="missing")

    with pytest.raises(ParserConfigurationError, match="Unknown parser provider"):
        build_parser(settings)


def test_http_vision_parser_requires_url(tmp_path: Path) -> None:
    parser = build_parser(Settings(data_dir=tmp_path, parser_provider="llm_vision", external_parser_url=None))

    with pytest.raises(ParserConfigurationError, match="POKER_EXTERNAL_PARSER_URL"):
        parser.parse(tmp_path / "table.png")


def test_http_vision_parser_posts_image_and_layout_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    request = httpx.Request("POST", "https://parser.example/parse")
    captured: dict[str, object] = {}

    def fake_post(
        url: str,
        *,
        files: dict[str, tuple[str, BinaryIO, str]],
        data: dict[str, str],
        timeout: float,
    ) -> httpx.Response:
        image_name, image_file, content_type = files["image"]
        captured["url"] = url
        captured["image_name"] = image_name
        captured["image_bytes"] = image_file.read()
        captured["content_type"] = content_type
        captured["data"] = data
        captured["timeout"] = timeout
        return httpx.Response(
            200,
            json={
                "state": {
                    "hero_cards": [{"rank": "A", "suit": "hearts"}],
                    "street": "preflop",
                },
                "confidences": {"hero_cards": 0.91},
                "raw": {"provider": "test-vision"},
            },
            request=request,
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    parser = build_parser(
        Settings(
            data_dir=tmp_path,
            parser_provider="llm_vision",
            external_parser_url="https://parser.example/parse",
            parser_layout_profile="ignition",
        )
    )

    result = parser.parse(image_path)

    assert result.state.hero_cards[0].code == "Ah"
    assert result.confidences["hero_cards"] == 0.91
    assert captured == {
        "url": "https://parser.example/parse",
        "image_name": "table.png",
        "image_bytes": b"fake image bytes",
        "content_type": "application/octet-stream",
        "data": {"layout_profile": "ignition"},
        "timeout": 60.0,
    }


def test_http_vision_parser_missing_file_raises_parser_error(tmp_path: Path) -> None:
    parser = build_parser(
        Settings(
            data_dir=tmp_path,
            parser_provider="llm_vision",
            external_parser_url="https://parser.example/parse",
        )
    )

    with pytest.raises(ParserError, match="Screenshot file does not exist"):
        parser.parse(tmp_path / "missing.png")


def test_http_vision_parser_non_success_status_raises_parser_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    request = httpx.Request("POST", "https://parser.example/parse")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"}, request=request)

    monkeypatch.setattr(httpx, "post", fake_post)
    parser = build_parser(
        Settings(
            data_dir=tmp_path,
            parser_provider="llm_vision",
            external_parser_url="https://parser.example/parse",
        )
    )

    with pytest.raises(ParserError, match="status 503"):
        parser.parse(image_path)


def test_http_vision_parser_request_failure_raises_parser_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        raise httpx.RequestError("connection refused")

    monkeypatch.setattr(httpx, "post", fake_post)
    parser = build_parser(
        Settings(
            data_dir=tmp_path,
            parser_provider="llm_vision",
            external_parser_url="https://parser.example/parse",
        )
    )

    with pytest.raises(ParserError, match="Vision parser request failed"):
        parser.parse(image_path)


def test_http_vision_parser_invalid_json_raises_parser_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    request = httpx.Request("POST", "https://parser.example/parse")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(200, content=b"not-json", request=request)

    monkeypatch.setattr(httpx, "post", fake_post)
    parser = build_parser(
        Settings(
            data_dir=tmp_path,
            parser_provider="llm_vision",
            external_parser_url="https://parser.example/parse",
        )
    )

    with pytest.raises(ParserError, match="invalid JSON"):
        parser.parse(image_path)


def test_http_vision_parser_invalid_payload_raises_parser_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    request = httpx.Request("POST", "https://parser.example/parse")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            json={"state": {"hero_cards": [{"rank": "1", "suit": "hearts"}]}},
            request=request,
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    parser = build_parser(
        Settings(
            data_dir=tmp_path,
            parser_provider="llm_vision",
            external_parser_url="https://parser.example/parse",
        )
    )

    with pytest.raises(ParserError, match="invalid payload"):
        parser.parse(image_path)


def test_ocr_cv_parser_returns_configuration_error(tmp_path: Path) -> None:
    parser = build_parser(Settings(data_dir=tmp_path, parser_provider="ocr_cv"))

    with pytest.raises(ParserConfigurationError, match="OCR/CV parser requires"):
        parser.parse(tmp_path / "table.png")
