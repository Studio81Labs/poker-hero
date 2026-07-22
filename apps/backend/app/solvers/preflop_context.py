from __future__ import annotations

import re
from typing import Literal

from app.models import RecommendationRequest

Position = Literal["utg", "hijack", "cutoff", "button", "small_blind", "big_blind"]

POSITION_ALIASES: dict[str, Position] = {
    "utg": "utg",
    "under the gun": "utg",
    "ep": "utg",
    "early": "utg",
    "early position": "utg",
    "hj": "hijack",
    "hijack": "hijack",
    "mp": "hijack",
    "middle": "hijack",
    "middle position": "hijack",
    "co": "cutoff",
    "cutoff": "cutoff",
    "btn": "button",
    "button": "button",
    "dealer": "button",
    "sb": "small_blind",
    "small blind": "small_blind",
    "bb": "big_blind",
    "big blind": "big_blind",
}
POSITION_ACTION_ORDER: dict[Position, int] = {
    "utg": 0,
    "hijack": 1,
    "cutoff": 2,
    "button": 3,
    "small_blind": 4,
    "big_blind": 5,
}

POSITION_REFERENCE = (
    r"under the gun|early position|middle position|small blind|big blind|"
    r"utg|ep|hijack|hj|mp|cutoff|co|button|btn|dealer|sb|bb"
)
POSITION_OPEN_RAISE_PATTERNS = (
    re.compile(
        rf"\b(?P<position>{POSITION_REFERENCE})\b\s+(?:open\s+)?rais(?:e|es|ed)\b",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\brais(?:e|es|ed)\b\s+from\s+(?P<position>{POSITION_REFERENCE})\b",
        re.IGNORECASE,
    ),
)
CALLER_ACTION_PATTERN = re.compile(
    r"\b(?:calls|called|callers?|overcalls?|cold calls?|flats?)\b",
    re.IGNORECASE,
)
LATER_RAISE_PATTERN = re.compile(
    r"\b(?:(?:[3-9]|\d{2,})|three|four|five|six|seven|eight|nine)\s*bets?\b"
    r"|\bre\s*raises?\b",
    re.IGNORECASE,
)
MIN_BLIND_ONLY_POT_BB = 1.25
MAX_BLIND_ONLY_POT_BB = 1.75
MAX_SINGLE_OPEN_CALL_BB = 4.0
MAX_SINGLE_OPEN_DEAD_MONEY_BB = 4.0


def supports_preflop_chart(request: RecommendationRequest) -> bool:
    state = request.state
    if state.street != "preflop" or len(state.hero_cards) != 2 or state.board_cards:
        return False
    if state.players_in_hand is None or not 2 <= state.players_in_hand <= 6:
        return False
    position = normalize_position(state.hero_position)
    if position is None:
        return False
    if _has_unsupported_action_history(state.action_context):
        return False

    current_bet = state.current_bet or 0
    if current_bet <= 0:
        pot_size = state.pot_size or 0
        return MIN_BLIND_ONLY_POT_BB <= pot_size <= MAX_BLIND_ONLY_POT_BB
    if state.facing_action != "raise" or current_bet > MAX_SINGLE_OPEN_CALL_BB:
        return False

    pot_size = state.pot_size or 0
    dead_money = pot_size - current_bet
    if pot_size < current_bet or dead_money > MAX_SINGLE_OPEN_DEAD_MONEY_BB:
        return False

    opener_position = _opening_raise_position(state.action_context)
    if opener_position is None:
        return False
    return POSITION_ACTION_ORDER[opener_position] < POSITION_ACTION_ORDER[position]


def normalize_position(value: str | None) -> Position | None:
    if value is None:
        return None
    normalized = " ".join(value.lower().replace("_", " ").replace("-", " ").split())
    return POSITION_ALIASES.get(normalized)


def _has_unsupported_action_history(action_context: str | None) -> bool:
    if action_context is None:
        return False
    normalized = " ".join(action_context.lower().replace("-", " ").split())
    return "limp" in normalized or bool(
        CALLER_ACTION_PATTERN.search(normalized) or LATER_RAISE_PATTERN.search(normalized)
    )


def _opening_raise_position(action_context: str | None) -> Position | None:
    if action_context is None:
        return None
    normalized = " ".join(action_context.lower().replace("-", " ").split())
    for pattern in POSITION_OPEN_RAISE_PATTERNS:
        match = pattern.search(normalized)
        if match is not None:
            return normalize_position(match.group("position"))
    return None
