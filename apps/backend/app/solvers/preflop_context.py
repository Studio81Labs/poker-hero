from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal

from app.models import CanonicalState, PreflopPosition, RecommendationRequest

Position = PreflopPosition

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
POSTED_BLIND_BB: dict[Position, float] = {
    "utg": 0.0,
    "hijack": 0.0,
    "cutoff": 0.0,
    "button": 0.0,
    "small_blind": 0.5,
    "big_blind": 1.0,
}

POSITION_REFERENCE = (
    r"under the gun|early position|middle position|small blind|big blind|"
    r"utg|ep|hijack|hj|mp|cutoff|co|button|btn|dealer|sb|bb"
)
OPEN_RAISE_ACTION_REFERENCE = r"(?:open(?:s|ed)?|(?:open\s+)?rais(?:e|es|ed))"
POSITION_OPEN_RAISE_PATTERNS = (
    re.compile(
        rf"\b(?P<position>{POSITION_REFERENCE})\b\s+{OPEN_RAISE_ACTION_REFERENCE}\b",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\brais(?:e|es|ed)\b\s+from\s+(?P<position>{POSITION_REFERENCE})\b",
        re.IGNORECASE,
    ),
)
POSITION_OPEN_RAISE_SIZE_PATTERN = re.compile(
    rf"\b(?:{POSITION_REFERENCE})\b\s+{OPEN_RAISE_ACTION_REFERENCE}\b\s+to\s+"
    r"(?P<size>\d+(?:\.\d+)?)\s*bb\b",
    re.IGNORECASE,
)
CALLER_ACTION_PATTERN = re.compile(
    rf"\b(?:{POSITION_REFERENCE})\b\s+call\b|"
    r"\b(?:calls|called|callers?|overcall(?:s|ed|ing)?|"
    r"cold call(?:s|ed|ing)?|flat(?:s|ted|ting)?)\b",
    re.IGNORECASE,
)
LATER_RAISE_PATTERN = re.compile(
    r"\b(?:(?:[3-9]|\d{2,})|three|four|five|six|seven|eight|nine)\s*bets?\b"
    r"|\bre\s*rais(?:e|es|ed)\b",
    re.IGNORECASE,
)
RAISE_ACTION_PATTERN = re.compile(
    r"\b(?:open\s+rais(?:e|es|ed)|open(?:s|ed)?|rais(?:e|es|ed))\b",
    re.IGNORECASE,
)
NON_OPEN_AGGRESSION_PATTERN = re.compile(
    r"\ball\s*in\b|\bjam(?:s|med|ming)?\b|\bshov(?:e|es|ed|ing)\b|"
    r"\bsqueez(?:e|es|ed|ing)\b",
    re.IGNORECASE,
)
MIN_BLIND_ONLY_POT_BB = 1.25
MAX_BLIND_ONLY_POT_BB = 1.75
MIN_SINGLE_OPEN_SIZE_BB = 2.0
MAX_SINGLE_OPEN_SIZE_BB = 4.0
MONEY_TOLERANCE_BB = 0.05

PreflopChartScenario = Literal[
    "first_in",
    "big_blind_option",
    "facing_open_raise",
    "facing_three_bet",
]


@dataclass(frozen=True)
class PreflopChartContext:
    scenario: PreflopChartScenario
    hero_position: Position
    opener_position: Position | None = None
    opening_raise_size: float | None = None
    latest_aggressor_position: Position | None = None
    latest_raise_size: float | None = None


def supports_preflop_chart(request: RecommendationRequest) -> bool:
    return resolve_preflop_chart_context(request) is not None


def requires_hero_stack_for_preflop_chart(state: CanonicalState) -> bool:
    """Return whether hero_stack is the only missing chart-specific input."""
    if state.hero_stack is not None or len(state.preflop_action_history) != 2:
        return False

    assumed_hero_stack = max(
        state.effective_stack or 0,
        state.current_bet or 0,
        1.0,
    )
    candidate = RecommendationRequest(
        state=state.model_copy(update={"hero_stack": assumed_hero_stack}),
        provider="local_solver",
    )
    context = resolve_preflop_chart_context(candidate)
    return context is not None and context.scenario == "facing_three_bet"


def resolve_preflop_chart_context(
    request: RecommendationRequest,
) -> PreflopChartContext | None:
    state = request.state
    if state.street != "preflop" or len(state.hero_cards) != 2 or state.board_cards:
        return None
    if state.players_in_hand is None or not 2 <= state.players_in_hand <= 6:
        return None
    if state.effective_stack is None or state.effective_stack <= 0:
        return None
    position = normalize_position(state.hero_position)
    if position is None:
        return None

    current_bet = state.current_bet or 0
    if current_bet <= 0:
        if (
            state.facing_action is not None
            or state.preflop_opener_position is not None
            or state.preflop_open_size is not None
            or state.preflop_action_history
            or _has_raise_action(state.action_context)
            or _has_unsupported_action_history(state.action_context)
        ):
            return None
        pot_size = state.pot_size or 0
        if not MIN_BLIND_ONLY_POT_BB <= pot_size <= MAX_BLIND_ONLY_POT_BB:
            return None
        return PreflopChartContext(
            scenario=(
                "big_blind_option"
                if position == "big_blind"
                else "first_in"
            ),
            hero_position=position,
        )
    if state.facing_action != "raise":
        return None

    if state.preflop_action_history:
        return _structured_preflop_context(request, position)
    if _has_unsupported_action_history(state.action_context):
        return None

    opener_position = opening_raise_position(
        state.action_context,
        state.preflop_opener_position,
    )
    if opener_position is None:
        return None
    if POSITION_ACTION_ORDER[opener_position] >= POSITION_ACTION_ORDER[position]:
        return None
    opener_size = resolve_opening_raise_size(
        action_context=state.action_context,
        explicit_size=state.preflop_open_size,
        amount_to_call=current_bet,
        hero_position=position,
    )
    expected_open_size = current_bet + POSTED_BLIND_BB[position]
    if not MIN_SINGLE_OPEN_SIZE_BB <= opener_size <= MAX_SINGLE_OPEN_SIZE_BB:
        return None
    if abs(opener_size - expected_open_size) > MONEY_TOLERANCE_BB:
        return None

    pot_size = state.pot_size or 0
    dead_money = pot_size - current_bet
    blind_adjustment = POSTED_BLIND_BB[position] - POSTED_BLIND_BB[opener_position]
    if not (
        MIN_BLIND_ONLY_POT_BB + blind_adjustment
        <= dead_money
        <= MAX_BLIND_ONLY_POT_BB + blind_adjustment
    ):
        return None
    return PreflopChartContext(
        scenario="facing_open_raise",
        hero_position=position,
        opener_position=opener_position,
        opening_raise_size=opener_size,
        latest_aggressor_position=opener_position,
        latest_raise_size=opener_size,
    )


def _structured_preflop_context(
    request: RecommendationRequest,
    hero_position: Position,
) -> PreflopChartContext | None:
    state = request.state
    history = state.preflop_action_history
    if len(history) not in {1, 2} or any(
        action.action != "raise" for action in history
    ):
        return None

    opener = history[0]
    opener_position: Position = opener.actor
    opener_size = opener.amount
    if not MIN_SINGLE_OPEN_SIZE_BB <= opener_size <= MAX_SINGLE_OPEN_SIZE_BB:
        return None
    if (
        state.preflop_opener_position is not None
        and normalize_position(state.preflop_opener_position) != opener_position
    ):
        return None
    if (
        state.preflop_open_size is not None
        and abs(state.preflop_open_size - opener_size) > MONEY_TOLERANCE_BB
    ):
        return None

    if len(history) == 1:
        if (
            opener_position == hero_position
            or POSITION_ACTION_ORDER[opener_position]
            >= POSITION_ACTION_ORDER[hero_position]
        ):
            return None
        if not _amount_to_call_matches(
            state.current_bet,
            opener_size - POSTED_BLIND_BB[hero_position],
        ):
            return None
        if not _pot_matches_actions(
            state.pot_size,
            ((opener_position, opener_size),),
        ):
            return None
        return PreflopChartContext(
            scenario="facing_open_raise",
            hero_position=hero_position,
            opener_position=opener_position,
            opening_raise_size=opener_size,
            latest_aggressor_position=opener_position,
            latest_raise_size=opener_size,
        )

    three_bet = history[1]
    three_bettor_position: Position = three_bet.actor
    if opener_position != hero_position:
        return None
    if (
        three_bettor_position == hero_position
        or POSITION_ACTION_ORDER[three_bettor_position]
        <= POSITION_ACTION_ORDER[hero_position]
    ):
        return None
    minimum_full_raise = opener_size + max(1.0, opener_size - 1.0)
    if three_bet.amount + MONEY_TOLERANCE_BB < minimum_full_raise:
        return None
    if not _amount_to_call_matches(
        state.current_bet,
        three_bet.amount - opener_size,
    ):
        return None
    if (
        state.hero_stack is None
        or state.hero_stack <= 0
        or state.effective_stack is None
        or state.effective_stack > state.hero_stack + MONEY_TOLERANCE_BB
        or (state.current_bet or 0) > state.hero_stack + MONEY_TOLERANCE_BB
    ):
        return None
    if not _pot_matches_actions(
        state.pot_size,
        (
            (hero_position, opener_size),
            (three_bettor_position, three_bet.amount),
        ),
    ):
        return None
    return PreflopChartContext(
        scenario="facing_three_bet",
        hero_position=hero_position,
        opener_position=hero_position,
        opening_raise_size=opener_size,
        latest_aggressor_position=three_bettor_position,
        latest_raise_size=three_bet.amount,
    )


def _amount_to_call_matches(actual: float | None, expected: float) -> bool:
    return actual is not None and abs(actual - expected) <= MONEY_TOLERANCE_BB


def _pot_matches_actions(
    pot_size: float | None,
    commitments: tuple[tuple[Position, float], ...],
) -> bool:
    if pot_size is None:
        return False
    replaced_blinds = sum(POSTED_BLIND_BB[position] for position, _ in commitments)
    committed = sum(amount for _, amount in commitments)
    minimum = MIN_BLIND_ONLY_POT_BB - replaced_blinds + committed
    maximum = MAX_BLIND_ONLY_POT_BB - replaced_blinds + committed
    return minimum - MONEY_TOLERANCE_BB <= pot_size <= maximum + MONEY_TOLERANCE_BB


def normalize_position(value: str | None) -> Position | None:
    if value is None:
        return None
    normalized = " ".join(value.lower().replace("_", " ").replace("-", " ").split())
    return POSITION_ALIASES.get(normalized)


def opening_raise_size(action_context: str | None) -> float | None:
    if action_context is None:
        return None
    normalized = " ".join(action_context.lower().replace("-", " ").split())
    match = POSITION_OPEN_RAISE_SIZE_PATTERN.search(normalized)
    return float(match.group("size")) if match is not None else None


def resolve_opening_raise_size(
    *,
    action_context: str | None,
    explicit_size: float | None,
    amount_to_call: float,
    hero_position: Position,
) -> float:
    if explicit_size is not None:
        return explicit_size
    parsed_size = opening_raise_size(action_context)
    if parsed_size is not None:
        return parsed_size
    return amount_to_call + POSTED_BLIND_BB[hero_position]


def _has_unsupported_action_history(action_context: str | None) -> bool:
    if action_context is None:
        return False
    normalized = " ".join(action_context.lower().replace("-", " ").split())
    raise_count = len(RAISE_ACTION_PATTERN.findall(normalized))
    return "limp" in normalized or raise_count > 1 or bool(
        CALLER_ACTION_PATTERN.search(normalized)
        or LATER_RAISE_PATTERN.search(normalized)
        or NON_OPEN_AGGRESSION_PATTERN.search(normalized)
    )


def opening_raise_position(
    action_context: str | None,
    explicit_position: str | None = None,
) -> Position | None:
    if explicit_position is not None:
        return normalize_position(explicit_position)
    if action_context is None:
        return None
    normalized = " ".join(action_context.lower().replace("-", " ").split())
    for pattern in POSITION_OPEN_RAISE_PATTERNS:
        match = pattern.search(normalized)
        if match is not None:
            return normalize_position(match.group("position"))
    return None


def _has_raise_action(action_context: str | None) -> bool:
    if action_context is None:
        return False
    normalized = " ".join(action_context.lower().replace("-", " ").split())
    return bool(RAISE_ACTION_PATTERN.search(normalized))
