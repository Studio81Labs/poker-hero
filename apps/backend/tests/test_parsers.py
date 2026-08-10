from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from typing import BinaryIO

import httpx
import pytest
from PIL import Image

from app.config import KNOWN_PARSER_PROVIDERS, OCR_CV_LAYOUT_PROFILES, Settings
from app.ocr_layouts import (
    FORTUNA_NATIONS_LAYOUT,
    OCR_CV_LAYOUT_PROFILE_IDS,
    get_ocr_layout,
)
from app.parsers.base import ParserConfigurationError, ParserError
from app.parsers.ocr_cv import (
    CALL_AMOUNT_BOX,
    POT_BOX,
    RAISE_TO_AMOUNT_BOX,
    MoneyScale,
    NumberRead,
    OcrCvParser,
    _big_blind_from_numeric_sequence,
    _classify_suit,
    _clean_number_text,
    _facing_action_from_controls,
    _hero_slots_have_visible_cards,
    _match_rank,
    _money_scale_from_image,
    _number_box_has_bb_suffix,
    _parse_card_slot,
    _parse_numeric_state,
    _rank_template,
    _scale_box,
    _street_from_board_count,
    format_number,
)
from app.parsers.registry import (
    PARSER_PLUGINS,
    PARSER_PLUGIN_IDS,
    ParserPlugin,
    _plugin_catalog,
    build_parser,
    get_parser_plugin,
)


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


def test_parser_plugin_catalog_matches_configuration_allowlist(tmp_path: Path) -> None:
    assert PARSER_PLUGIN_IDS == KNOWN_PARSER_PROVIDERS
    assert list(PARSER_PLUGINS) == ["mock", "llm_vision", "ocr_cv"]

    mock = get_parser_plugin("mock")
    external = get_parser_plugin("llm_vision")
    local_ocr = get_parser_plugin("ocr_cv")

    assert mock.label == "Mock parser"
    assert mock.supports_layout("pokerstars")
    assert external.label == "External vision"
    assert external.supports_layout("pokerstars")
    assert external.unavailable_reason(Settings(data_dir=tmp_path)) == (
        "External parser URL is not configured"
    )
    assert (
        external.unavailable_reason(
            Settings(
                data_dir=tmp_path,
                external_parser_url="https://parser.example.com/parse",
            )
        )
        is None
    )
    assert local_ocr.label == "Template OCR"
    assert local_ocr.supports_layout("fortuna")
    assert not local_ocr.supports_layout("pokerstars")


def test_parser_plugin_rejects_factory_identity_mismatch(tmp_path: Path) -> None:
    mismatched = ParserPlugin(
        id="different",
        label="Different parser",
        factory=PARSER_PLUGINS["mock"].factory,
    )

    with pytest.raises(
        ParserConfigurationError,
        match="built parser 'mock'",
    ):
        mismatched.build(Settings(data_dir=tmp_path))


def test_parser_plugin_catalog_rejects_invalid_descriptors() -> None:
    factory = PARSER_PLUGINS["mock"].factory

    with pytest.raises(ValueError, match="identity fields"):
        ParserPlugin(id="", label="Missing ID", factory=factory)
    with pytest.raises(TypeError, match="factory must be callable"):
        ParserPlugin(  # type: ignore[arg-type]
            id="invalid_factory",
            label="Invalid factory",
            factory=None,
        )
    with pytest.raises(ValueError, match="must not be empty"):
        ParserPlugin(
            id="empty_layouts",
            label="Empty layouts",
            factory=factory,
            supported_layouts=frozenset(),
        )
    with pytest.raises(ValueError, match="IDs must be unique"):
        _plugin_catalog(PARSER_PLUGINS["mock"], PARSER_PLUGINS["mock"])


@pytest.mark.parametrize(
    ("amount_to_call", "raise_to_amount", "expected"),
    [
        (10.0, 20.0, "bet"),
        (10.0, 20.009, "bet"),
        (10.0, 20.2, None),
        (10.0, 25.0, None),
        (0.0, 2.0, None),
        (10.0, None, None),
        (10.0, 15.0, None),
    ],
)
def test_facing_action_from_postflop_controls(
    amount_to_call: float,
    raise_to_amount: float | None,
    expected: str | None,
) -> None:
    assert _facing_action_from_controls(amount_to_call, raise_to_amount) == expected


def test_numeric_parser_records_unambiguous_postflop_bet_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reads = {
        POT_BOX: NumberRead(value=31.7, text="31.70", confidence=0.9),
        CALL_AMOUNT_BOX: NumberRead(value=10, text="10", confidence=0.78),
        RAISE_TO_AMOUNT_BOX: NumberRead(value=20, text="20", confidence=0.73),
    }

    def read_number(_image: Image.Image, box: tuple[int, int, int, int], *_args, **_kwargs):
        return reads.get(box)

    monkeypatch.setattr("app.parsers.ocr_cv._read_number_from_box", read_number)
    monkeypatch.setattr("app.parsers.ocr_cv._read_stack_number_from_box", lambda *_args: None)
    monkeypatch.setattr("app.parsers.ocr_cv._card_back_confidence", lambda *_args: 0.0)

    state, confidences, raw, manual_review_fields = _parse_numeric_state(
        Image.new("RGB", (973, 691)),
        street="river",
    )

    assert state["current_bet"] == 10
    assert state["facing_action"] == "bet"
    assert state["opponent_wager"] == 10
    assert state["action_context"] == "Hero faces a 10 BB bet into 31.7 BB pot"
    assert confidences["facing_action"] == 0.73
    assert raw["raise_to"]["value"] == 20
    assert "facing_action" not in manual_review_fields
    assert "opponent_wager" not in manual_review_fields


@pytest.mark.parametrize(
    ("call_confidence", "raise_confidence"),
    [(0.69, 0.9), (0.9, 0.69)],
)
def test_numeric_parser_rejects_low_confidence_postflop_action_controls(
    monkeypatch: pytest.MonkeyPatch,
    call_confidence: float,
    raise_confidence: float,
) -> None:
    reads = {
        POT_BOX: NumberRead(value=31.7, text="31.70", confidence=0.9),
        CALL_AMOUNT_BOX: NumberRead(value=10, text="10", confidence=call_confidence),
        RAISE_TO_AMOUNT_BOX: NumberRead(value=20, text="20", confidence=raise_confidence),
    }

    def read_number(_image: Image.Image, box: tuple[int, int, int, int], *_args, **_kwargs):
        return reads.get(box)

    monkeypatch.setattr("app.parsers.ocr_cv._read_number_from_box", read_number)
    monkeypatch.setattr("app.parsers.ocr_cv._read_stack_number_from_box", lambda *_args: None)
    monkeypatch.setattr("app.parsers.ocr_cv._card_back_confidence", lambda *_args: 0.0)

    state, confidences, _raw, manual_review_fields = _parse_numeric_state(
        Image.new("RGB", (973, 691)),
        street="river",
    )

    assert "facing_action" not in state
    assert "opponent_wager" not in state
    assert "facing_action" not in confidences
    assert "opponent_wager" not in confidences
    assert "opponent_wager" in manual_review_fields


def test_numeric_parser_requires_known_postflop_street_for_wager_inference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reads = {
        POT_BOX: NumberRead(value=31.7, text="31.70", confidence=0.9),
        CALL_AMOUNT_BOX: NumberRead(value=10, text="10", confidence=0.9),
        RAISE_TO_AMOUNT_BOX: NumberRead(value=20, text="20", confidence=0.9),
    }

    def read_number(_image: Image.Image, box: tuple[int, int, int, int], *_args, **_kwargs):
        return reads.get(box)

    monkeypatch.setattr("app.parsers.ocr_cv._read_number_from_box", read_number)
    monkeypatch.setattr("app.parsers.ocr_cv._read_stack_number_from_box", lambda *_args: None)
    monkeypatch.setattr("app.parsers.ocr_cv._card_back_confidence", lambda *_args: 0.0)

    state, confidences, raw, _manual_review_fields = _parse_numeric_state(
        Image.new("RGB", (973, 691)),
        street=None,
    )

    assert "raise_to" not in raw
    assert "facing_action" not in state
    assert "opponent_wager" not in state
    assert "facing_action" not in confidences
    assert "opponent_wager" not in confidences


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


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("pot_size", "12.5"),
        ("players_in_hand", True),
    ],
)
def test_http_vision_parser_rejects_coerced_numeric_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field_name: str,
    value: object,
) -> None:
    image_path = tmp_path / "table.png"
    image_path.write_bytes(b"fake image bytes")
    request = httpx.Request("POST", "https://parser.example/parse")

    def fake_post(*args: object, **kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            json={"state": {field_name: value}},
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
    assert parser.layout is FORTUNA_NATIONS_LAYOUT


def test_local_ocr_layout_aliases_share_the_calibrated_engine() -> None:
    assert OCR_CV_LAYOUT_PROFILE_IDS == OCR_CV_LAYOUT_PROFILES

    for profile in OCR_CV_LAYOUT_PROFILE_IDS:
        assert get_ocr_layout(profile) is FORTUNA_NATIONS_LAYOUT


def test_local_ocr_layout_geometry_is_immutable() -> None:
    with pytest.raises(FrozenInstanceError):
        FORTUNA_NATIONS_LAYOUT.base_width = 1  # type: ignore[misc]

    with pytest.raises(TypeError):
        FORTUNA_NATIONS_LAYOUT.card_slots[0] = (  # type: ignore[index]
            FORTUNA_NATIONS_LAYOUT.card_slots[1]
        )


def test_local_ocr_layout_rejects_invalid_geometry() -> None:
    with pytest.raises(
        ValueError,
        match="pot box is outside its reference dimensions",
    ):
        replace(
            FORTUNA_NATIONS_LAYOUT,
            pot=replace(FORTUNA_NATIONS_LAYOUT.pot, box=(0, 0, 974, 10)),
        )

    with pytest.raises(ValueError, match="call amount numeric settings are invalid"):
        replace(
            FORTUNA_NATIONS_LAYOUT,
            call_amount=replace(FORTUNA_NATIONS_LAYOUT.call_amount, max_gap=0),
        )

    with pytest.raises(ValueError, match="duplicate card slot names"):
        replace(
            FORTUNA_NATIONS_LAYOUT,
            card_slots=(
                FORTUNA_NATIONS_LAYOUT.card_slots[0],
                FORTUNA_NATIONS_LAYOUT.card_slots[0],
            ),
        )

    with pytest.raises(ValueError, match="rank region is outside its card slot"):
        replace(
            FORTUNA_NATIONS_LAYOUT,
            card_slots=(
                replace(
                    FORTUNA_NATIONS_LAYOUT.card_slots[0],
                    rank_region=(0, 0, 100, 100),
                ),
            ),
        )

    with pytest.raises(ValueError, match="minimum capture scale"):
        replace(FORTUNA_NATIONS_LAYOUT, minimum_capture_scale=0)

    with pytest.raises(ValueError, match="aspect ratio tolerance"):
        replace(FORTUNA_NATIONS_LAYOUT, aspect_ratio_tolerance=0)


def test_local_ocr_layout_accepts_compatible_scaled_capture() -> None:
    FORTUNA_NATIONS_LAYOUT.validate_capture_dimensions(487, 346)


def test_ocr_cv_parser_rejects_capture_too_small_for_calibrated_regions(
    tmp_path: Path,
) -> None:
    image_path = tmp_path / "thumbnail.png"
    Image.new("RGB", (486, 345)).save(image_path)
    parser = OcrCvParser()

    with pytest.raises(
        ParserError,
        match=r"too small.*486x345.*at least 487x346",
    ):
        parser.parse(image_path)


def test_ocr_cv_parser_rejects_incompatible_capture_shape(tmp_path: Path) -> None:
    image_path = tmp_path / "full-screen.png"
    Image.new("RGB", (973, 973)).save(image_path)
    parser = OcrCvParser()

    with pytest.raises(
        ParserError,
        match=r"dimensions 973x973 do not match.*capture only the full poker table window",
    ):
        parser.parse(image_path)


def test_ocr_cv_parser_rejects_unknown_layout_without_fallback(tmp_path: Path) -> None:
    with pytest.raises(
        ParserConfigurationError,
        match="Unknown local OCR layout profile: pokerstars",
    ):
        build_parser(
            Settings(
                data_dir=tmp_path,
                parser_provider="ocr_cv",
                parser_layout_profile="pokerstars",
            )
        )


def test_ocr_cv_scales_regions_against_the_selected_layout() -> None:
    layout = replace(
        FORTUNA_NATIONS_LAYOUT,
        id="test",
        base_width=1946,
        base_height=1382,
    )

    assert _scale_box((100, 200, 400, 600), 973, 691, layout) == (50, 100, 200, 300)


def test_ocr_cv_uses_layout_card_rank_region() -> None:
    slot = replace(
        FORTUNA_NATIONS_LAYOUT.card_slots[0],
        box=(100, 100, 166, 174),
        rank_region=(5, 6, 20, 30),
    )

    parsed = _parse_card_slot(
        Image.new("RGB", (973, 691)),
        slot,
        FORTUNA_NATIONS_LAYOUT,
    )

    assert parsed["raw"]["card_box"] == [100, 100, 166, 174]
    assert parsed["raw"]["rank_box"] == [105, 106, 120, 130]


def test_ocr_cv_uses_layout_numeric_regions(monkeypatch: pytest.MonkeyPatch) -> None:
    layout = replace(
        FORTUNA_NATIONS_LAYOUT,
        id="test",
        pot=replace(
            FORTUNA_NATIONS_LAYOUT.pot,
            box=(10, 10, 100, 40),
            mode="dark",
            start_group=1,
            max_gap=3,
            min_height=2,
        ),
        hero_stack_box=(10, 50, 100, 80),
        call_amount=replace(
            FORTUNA_NATIONS_LAYOUT.call_amount,
            box=(10, 90, 100, 120),
            mode="light",
            start_group=2,
            max_gap=4,
            min_height=3,
        ),
        raise_to_amount=replace(
            FORTUNA_NATIONS_LAYOUT.raise_to_amount,
            box=(10, 130, 100, 160),
            mode="light",
            start_group=3,
            max_gap=5,
            min_height=4,
        ),
        opponent_seats=(),
    )
    number_calls: list[tuple[object, ...]] = []
    stack_calls: list[tuple[object, ...]] = []

    def read_number(
        _image: Image.Image,
        box: tuple[int, int, int, int],
        mode: str,
        selected_layout: object,
        **options: int,
    ) -> NumberRead | None:
        number_calls.append((box, mode, selected_layout, options))
        values = {
            layout.pot.box: NumberRead(value=10, text="10", confidence=0.9),
            layout.call_amount.box: NumberRead(value=2, text="2", confidence=0.9),
            layout.raise_to_amount.box: NumberRead(value=4, text="4", confidence=0.9),
        }
        return values.get(box)

    def read_stack(
        _image: Image.Image,
        box: tuple[int, int, int, int],
        selected_layout: object,
    ) -> NumberRead:
        stack_calls.append((box, selected_layout))
        return NumberRead(value=50, text="50", confidence=0.9)

    monkeypatch.setattr("app.parsers.ocr_cv._read_number_from_box", read_number)
    monkeypatch.setattr("app.parsers.ocr_cv._read_stack_number_from_box", read_stack)
    monkeypatch.setattr(
        "app.parsers.ocr_cv._money_scale_from_image",
        lambda _image, _layout: MoneyScale(scale=1, display_unit="bb", big_blind=None),
    )

    state, _confidences, _raw, _manual_review_fields = _parse_numeric_state(
        Image.new("RGB", (973, 691)),
        layout=layout,
        street="flop",
    )

    assert state["pot_size"] == 10
    assert state["current_bet"] == 2
    assert state["opponent_wager"] == 2
    assert number_calls == [
        (layout.pot.box, "dark", layout, {"start_group": 1, "max_gap": 3, "min_height": 2}),
        (
            layout.call_amount.box,
            "light",
            layout,
            {"start_group": 2, "max_gap": 4, "min_height": 3},
        ),
        (
            layout.raise_to_amount.box,
            "light",
            layout,
            {"start_group": 3, "max_gap": 5, "min_height": 4},
        ),
    ]
    assert stack_calls == [(layout.hero_stack_box, layout)]


def test_ocr_cv_uses_pot_text_mode_for_bb_suffix_detection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layout = replace(
        FORTUNA_NATIONS_LAYOUT,
        id="dark_pot",
        pot=replace(FORTUNA_NATIONS_LAYOUT.pot, mode="dark"),
    )
    captured_modes: list[str] = []

    def numeric_groups(
        _crop: Image.Image,
        mode: str,
        *,
        min_height: int,
    ) -> tuple[list[tuple[int, int, int, int, int]], list[list[bool]]]:
        captured_modes.append(mode)
        return [], []

    monkeypatch.setattr("app.parsers.ocr_cv._numeric_groups", numeric_groups)

    assert not _number_box_has_bb_suffix(
        Image.new("RGB", (973, 691)),
        layout.pot.box,
        layout,
        mode=layout.pot.mode,
        start_group=layout.pot.start_group,
        max_gap=layout.pot.max_gap,
        min_height=layout.pot.min_height,
    )
    assert captured_modes == ["dark"]


def test_money_scale_forwards_pot_text_mode_to_suffix_detection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    layout = replace(
        FORTUNA_NATIONS_LAYOUT,
        id="dark_pot",
        pot=replace(FORTUNA_NATIONS_LAYOUT.pot, mode="dark"),
    )
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        "app.parsers.ocr_cv._read_big_blind_from_header",
        lambda _image, _layout: 0.1,
    )

    def has_bb_suffix(
        _image: Image.Image,
        box: tuple[int, int, int, int],
        selected_layout: object,
        **options: object,
    ) -> bool:
        captured.update(box=box, layout=selected_layout, options=options)
        return True

    monkeypatch.setattr("app.parsers.ocr_cv._number_box_has_bb_suffix", has_bb_suffix)

    scale = _money_scale_from_image(Image.new("RGB", (973, 691)), layout)

    assert scale.scale == 1
    assert captured == {
        "box": layout.pot.box,
        "layout": layout,
        "options": {
            "mode": "dark",
            "start_group": layout.pot.start_group,
            "max_gap": layout.pot.max_gap,
            "min_height": layout.pot.min_height,
        },
    }


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
