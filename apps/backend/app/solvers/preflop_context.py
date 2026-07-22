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


def supports_preflop_chart(request: RecommendationRequest) -> bool:
    state = request.state
    if state.street != "preflop" or len(state.hero_cards) != 2 or state.board_cards:
        return False
    if normalize_position(state.hero_position) is None:
        return False
    if _has_unsupported_action_history(state.action_context):
        return False

    current_bet = state.current_bet or 0
    if current_bet <= 0:
        pot_size = state.pot_size or 0
        return MIN_BLIND_ONLY_POT_BB <= pot_size <= MAX_BLIND_ONLY_POT_BB
    return state.facing_action == "raise"


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
