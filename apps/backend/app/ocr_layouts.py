from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, Mapping

PixelBox = tuple[int, int, int, int]
SlotKind = Literal["hero", "board"]
TextMode = Literal["light", "dark"]


@dataclass(frozen=True)
class CardSlot:
    name: str
    kind: SlotKind
    box: PixelBox
    rank_region: PixelBox = (0, 0, 26, 38)


@dataclass(frozen=True)
class NumericRegion:
    box: PixelBox
    mode: TextMode
    start_group: int = 0
    max_gap: int = 8
    min_height: int = 0


@dataclass(frozen=True)
class OpponentSeat:
    name: str
    card_box: PixelBox
    stack_box: PixelBox


@dataclass(frozen=True)
class OcrLayout:
    id: str
    label: str
    engine: str
    base_width: int
    base_height: int
    pot: NumericRegion
    hero_stack_box: PixelBox
    call_amount: NumericRegion
    raise_to_amount: NumericRegion
    header_stakes: NumericRegion
    card_slots: tuple[CardSlot, ...]
    opponent_seats: tuple[OpponentSeat, ...]

    def __post_init__(self) -> None:
        if not self.id or not self.label or not self.engine:
            raise ValueError("OCR layout identity fields must not be empty")
        if self.base_width <= 0 or self.base_height <= 0:
            raise ValueError("OCR layout reference dimensions must be positive")

        named_boxes = [
            ("pot", self.pot.box),
            ("hero stack", self.hero_stack_box),
            ("call amount", self.call_amount.box),
            ("raise-to amount", self.raise_to_amount.box),
            ("header stakes", self.header_stakes.box),
        ]
        named_boxes.extend((f"card slot {slot.name}", slot.box) for slot in self.card_slots)
        named_boxes.extend(
            (f"seat {seat.name} cards", seat.card_box) for seat in self.opponent_seats
        )
        named_boxes.extend(
            (f"seat {seat.name} stack", seat.stack_box) for seat in self.opponent_seats
        )
        for name, box in named_boxes:
            _validate_box(name, box, self.base_width, self.base_height)
        for name, region in (
            ("pot", self.pot),
            ("call amount", self.call_amount),
            ("raise-to amount", self.raise_to_amount),
            ("header stakes", self.header_stakes),
        ):
            _validate_numeric_region(name, region)
        for slot in self.card_slots:
            _validate_relative_box(
                f"card slot {slot.name} rank",
                slot.rank_region,
                slot.box[2] - slot.box[0],
                slot.box[3] - slot.box[1],
            )

        _validate_unique_names("card slot", [slot.name for slot in self.card_slots])
        _validate_unique_names("opponent seat", [seat.name for seat in self.opponent_seats])

    @property
    def aspect_ratio(self) -> float:
        return self.base_width / self.base_height

    @property
    def pot_box(self) -> PixelBox:
        return self.pot.box

    @property
    def call_amount_box(self) -> PixelBox:
        return self.call_amount.box

    @property
    def raise_to_amount_box(self) -> PixelBox:
        return self.raise_to_amount.box

    @property
    def header_stakes_box(self) -> PixelBox:
        return self.header_stakes.box


def _validate_box(name: str, box: PixelBox, width: int, height: int) -> None:
    left, top, right, bottom = box
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError(f"OCR layout {name} box is outside its reference dimensions")


def _validate_unique_names(kind: str, names: list[str]) -> None:
    if any(not name for name in names):
        raise ValueError(f"OCR layout {kind} names must not be empty")
    if len(names) != len(set(names)):
        raise ValueError(f"OCR layout contains duplicate {kind} names")


def _validate_relative_box(name: str, box: PixelBox, width: int, height: int) -> None:
    try:
        _validate_box(name, box, width, height)
    except ValueError as exc:
        raise ValueError(f"OCR layout {name} region is outside its card slot") from exc


def _validate_numeric_region(name: str, region: NumericRegion) -> None:
    if region.mode not in {"light", "dark"}:
        raise ValueError(f"OCR layout {name} text mode is invalid")
    if region.start_group < 0 or region.max_gap <= 0 or region.min_height < 0:
        raise ValueError(f"OCR layout {name} numeric settings are invalid")


FORTUNA_NATIONS_LAYOUT = OcrLayout(
    id="fortuna_nations",
    label="Fortuna/Nations",
    engine="fortuna_nations_fixed_v1",
    base_width=973,
    base_height=691,
    pot=NumericRegion(
        box=(420, 225, 560, 260),
        mode="light",
        start_group=4,
        max_gap=7,
    ),
    hero_stack_box=(430, 545, 575, 586),
    call_amount=NumericRegion(
        box=(740, 666, 858, 686),
        mode="dark",
        max_gap=8,
        min_height=6,
    ),
    raise_to_amount=NumericRegion(
        box=(858, 666, 973, 686),
        mode="dark",
        max_gap=8,
        min_height=6,
    ),
    header_stakes=NumericRegion(
        box=(0, 0, 560, 30),
        mode="light",
        min_height=3,
    ),
    card_slots=(
        CardSlot("hero_1", "hero", (420, 468, 486, 542)),
        CardSlot("hero_2", "hero", (486, 468, 552, 542)),
        CardSlot("board_1", "board", (319, 262, 384, 346)),
        CardSlot("board_2", "board", (386, 262, 451, 346)),
        CardSlot("board_3", "board", (454, 262, 519, 346)),
        CardSlot("board_4", "board", (522, 262, 587, 346)),
        CardSlot("board_5", "board", (590, 262, 655, 346)),
    ),
    opponent_seats=(
        OpponentSeat("top", (425, 45, 630, 130), (450, 144, 585, 166)),
        OpponentSeat("upper_left", (50, 120, 190, 220), (70, 205, 200, 245)),
        OpponentSeat("upper_right", (780, 120, 930, 220), (805, 220, 910, 244)),
        OpponentSeat("lower_left", (130, 410, 280, 500), (155, 514, 255, 538)),
        OpponentSeat("lower_right", (710, 410, 850, 500), (730, 514, 835, 538)),
    ),
)

OCR_LAYOUTS: Mapping[str, OcrLayout] = MappingProxyType(
    {
        "generic": FORTUNA_NATIONS_LAYOUT,
        "fortuna": FORTUNA_NATIONS_LAYOUT,
        "nations": FORTUNA_NATIONS_LAYOUT,
        "fortuna_nations": FORTUNA_NATIONS_LAYOUT,
    }
)
OCR_CV_LAYOUT_PROFILE_IDS = frozenset(OCR_LAYOUTS)


def get_ocr_layout(profile: str) -> OcrLayout:
    try:
        return OCR_LAYOUTS[profile]
    except KeyError as exc:
        raise ValueError(f"Unknown local OCR layout profile: {profile}") from exc
