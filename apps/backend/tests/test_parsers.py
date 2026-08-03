from pathlib import Path
from typing import BinaryIO

import httpx
import pytest
from PIL import Image

from app.config import Settings
from app.parsers.base import ParserConfigurationError, ParserError
from app.parsers.ocr_cv import (
    OcrCvParser,
    _big_blind_from_numeric_sequence,
    _classify_suit,
    _clean_number_text,
    _hero_slots_have_visible_cards,
    _match_rank,
    _rank_template,
    _street_from_board_count,
    format_number,
)
from app.parsers.registry import build_parser


def test_registry_builds_mock_parser(tmp_path: Path) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    parser = build_parser(Settings(data_dir=tmp_path, parser_provider="mock"))

    result = parser.parse(image_path)

    assert result.state.hero_cards[0].code == "Ah"
    assert result.state.hero_cards[1].code == "Kd"
    assert result.state.street == "flop"
    assert result.state.facing_action == "bet"
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
        headers: dict[str, str],
        timeout: float,
    ) -> httpx.Response:
        image_name, image_file, content_type = files["image"]
        captured["url"] = url
        captured["image_name"] = image_name
        captured["image_bytes"] = image_file.read()
        captured["content_type"] = content_type
        captured["data"] = data
        captured["headers"] = headers
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
            external_parser_bearer_token="parser-token",
            external_request_timeout_seconds=12.5,
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
        "headers": {"Authorization": "Bearer parser-token"},
        "timeout": 12.5,
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


@pytest.mark.parametrize("confidence", [True, "0.91"])
def test_http_vision_parser_rejects_coerced_confidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    confidence: object,
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    request = httpx.Request("POST", "https://parser.example/parse")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "state": {"street": "preflop"},
                "confidences": {"street": confidence},
            },
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


def test_registry_builds_ocr_cv_parser(tmp_path: Path) -> None:
    parser = build_parser(Settings(data_dir=tmp_path, parser_provider="ocr_cv"))

    assert isinstance(parser, OcrCvParser)
    assert parser.name == "ocr_cv"


def test_ocr_cv_parser_missing_file_raises_parser_error(tmp_path: Path) -> None:
    parser = build_parser(Settings(data_dir=tmp_path, parser_provider="ocr_cv"))

    with pytest.raises(ParserError, match="Screenshot file does not exist"):
        parser.parse(tmp_path / "table.png")


def test_ocr_cv_rank_templates_match_known_ranks() -> None:
    for rank in ["2", "3", "4", "5", "7", "8", "9", "T", "J", "Q", "K", "A"]:
        matched_rank, score = _match_rank(_rank_template(rank))

        assert matched_rank == rank
        assert score == 1.0


def test_ocr_cv_classifies_card_body_suits() -> None:
    examples = {
        "clubs": (22, 110, 41),
        "diamonds": (12, 116, 139),
        "hearts": (149, 22, 31),
        "spades": (88, 86, 90),
    }

    for expected_suit, rgb in examples.items():
        suit, confidence = _classify_suit(Image.new("RGB", (66, 74), rgb))

        assert suit == expected_suit
        assert confidence > 0.7


def test_ocr_cv_street_from_board_count() -> None:
    assert _street_from_board_count(0) == "preflop"
    assert _street_from_board_count(3) == "flop"
    assert _street_from_board_count(4) == "turn"
    assert _street_from_board_count(5) == "river"
    assert _street_from_board_count(2) is None


def test_ocr_cv_numeric_text_cleanup_limits_fractional_noise() -> None:
    assert _clean_number_text("16.100") == "16.10"
    assert _clean_number_text("4..50") == "4.50"
    assert _clean_number_text("...") is None


def test_ocr_cv_format_number_keeps_readable_bb_amounts() -> None:
    assert format_number(10.0) == "10"
    assert format_number(2.5) == "2.5"
    assert format_number(97.1) == "97.1"


def test_ocr_cv_reads_big_blind_from_noisy_header_sequence() -> None:
    assert _big_blind_from_numeric_sequence("1100.05?00.101.25.9.1.20") == 0.1
    assert _big_blind_from_numeric_sequence("0.10?0.20") == 0.2
    assert _big_blind_from_numeric_sequence("25.9.1.20") is None


def test_ocr_cv_distinguishes_empty_hero_slots_from_failed_hero_ocr() -> None:
    assert not _hero_slots_have_visible_cards(
        [
            {"kind": "hero", "reason": "empty"},
            {"kind": "hero", "reason": "empty"},
            {"kind": "board", "reason": "empty"},
        ]
    )
    assert _hero_slots_have_visible_cards(
        [
            {"kind": "hero", "reason": "rank_not_matched"},
            {"kind": "hero", "reason": "empty"},
        ]
    )
