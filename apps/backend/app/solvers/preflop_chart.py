from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from app.models import Card, RecommendationAction, RecommendationRequest, RecommendationResult
from app.providers.rule_based import _starting_hand_score
from app.solvers.preflop_context import (
    Position,
    normalize_position,
    opening_raise_size,
    supports_preflop_chart,
)

RANKS = tuple("AKQJT98765432")
RANK_INDEX = {rank: index for index, rank in enumerate(RANKS)}


@dataclass(frozen=True)
class PositionPolicy:
    open_fraction: float
    continue_fraction: float
    reraise_fraction: float


POSITION_POLICIES: dict[Position, PositionPolicy] = {
    "utg": PositionPolicy(0.17, 0.08, 0.04),
    "hijack": PositionPolicy(0.22, 0.11, 0.05),
    "cutoff": PositionPolicy(0.30, 0.16, 0.07),
    "button": PositionPolicy(0.45, 0.23, 0.09),
    "small_blind": PositionPolicy(0.40, 0.20, 0.09),
    "big_blind": PositionPolicy(0.0, 0.30, 0.08),
}

POSITION_LABELS: dict[Position, str] = {
    "utg": "UTG",
    "hijack": "hijack",
    "cutoff": "cutoff",
    "button": "button",
    "small_blind": "small blind",
    "big_blind": "big blind",
}
POSTED_BLIND_BB: dict[Position, float] = {
    "utg": 0.0,
    "hijack": 0.0,
    "cutoff": 0.0,
    "button": 0.0,
    "small_blind": 0.5,
    "big_blind": 1.0,
}


def solve_preflop_chart(request: RecommendationRequest) -> RecommendationResult | None:
    state = request.state
    if not supports_preflop_chart(request):
        return None

    position = normalize_position(state.hero_position)
    if position is None:
        return None

    hand_class = canonical_hand_class(state.hero_cards)
    top_fraction = hand_top_fraction(state.hero_cards)
    policy = POSITION_POLICIES[position]
    current_bet = state.current_bet or 0
    effective_stack = state.effective_stack or 0

    if current_bet <= 0:
        if (state.pot_size or 0) > 2.5:
            return None
        if position == "big_blind":
            return _result(
                action="check",
                sizing=None,
                confidence=0.78,
                hand_class=hand_class,
                top_fraction=top_fraction,
                position=position,
                scenario="big_blind_option",
                tier="check_option",
                policy_fraction=None,
                assumptions=[
                    "No amount is required to continue.",
                    "No limper or prior raise is represented in the approved state.",
                ],
            )
        should_open = top_fraction <= policy.open_fraction
        action: RecommendationAction = "raise" if should_open else "fold"
        sizing = _open_size(effective_stack) if should_open else None
        return _result(
            action=action,
            sizing=sizing,
            confidence=_boundary_confidence(top_fraction, policy.open_fraction),
            hand_class=hand_class,
            top_fraction=top_fraction,
            position=position,
            scenario="first_in",
            tier="open" if should_open else "fold",
            policy_fraction=policy.open_fraction,
            assumptions=[
                "The pot is treated as unopened with no limpers or prior hero action.",
                "The chart models a six-max chip-EV training spot before rake.",
            ],
        )

    if state.facing_action != "raise":
        return None

    if effective_stack <= current_bet:
        can_reraise = False
    else:
        can_reraise = top_fraction <= policy.reraise_fraction
    if can_reraise:
        action = "raise"
        opener_size = opening_raise_size(state.action_context)
        if opener_size is None:
            opener_size = current_bet + POSTED_BLIND_BB[position]
        sizing = _reraise_size(opener_size, state.pot_size or 0, effective_stack)
        tier = "reraise"
        boundary = policy.reraise_fraction
    elif top_fraction <= policy.continue_fraction:
        action = "call"
        sizing = None
        tier = "defend"
        boundary = policy.continue_fraction
    else:
        action = "fold"
        sizing = None
        tier = "fold"
        boundary = policy.continue_fraction

    return _result(
        action=action,
        sizing=sizing,
        confidence=_boundary_confidence(top_fraction, boundary),
        hand_class=hand_class,
        top_fraction=top_fraction,
        position=position,
        scenario="facing_open_raise",
        tier=tier,
        policy_fraction=boundary,
        assumptions=[
            "The approved action context is treated as one open raise with no callers or prior hero action.",
            "The defense chart uses a conservative opener-position average.",
            "The chart models a six-max chip-EV training spot before rake.",
        ],
    )


def canonical_hand_class(cards: list[Card]) -> str:
    if len(cards) != 2:
        raise ValueError("A preflop hand class requires exactly two cards")
    first, second = sorted(cards, key=lambda card: RANK_INDEX[card.rank])
    if first.rank == second.rank:
        return f"{first.rank}{second.rank}"
    suited = "s" if first.suit == second.suit else "o"
    return f"{first.rank}{second.rank}{suited}"


@lru_cache(maxsize=169)
def _top_fraction_for_class(hand_class: str) -> float:
    scores = _class_scores()
    target = scores[hand_class]
    at_least_as_strong = sum(1 for score in scores.values() if score >= target)
    return round(at_least_as_strong / len(scores), 4)


def hand_top_fraction(cards: list[Card]) -> float:
    return _top_fraction_for_class(canonical_hand_class(cards))


@lru_cache(maxsize=1)
def _class_scores() -> dict[str, float]:
    scores: dict[str, float] = {}
    for high_index, high_rank in enumerate(RANKS):
        pair = [Card(rank=high_rank, suit="hearts"), Card(rank=high_rank, suit="spades")]
        scores[f"{high_rank}{high_rank}"] = _chart_score(pair)
        for low_rank in RANKS[high_index + 1 :]:
            suited = [Card(rank=high_rank, suit="hearts"), Card(rank=low_rank, suit="hearts")]
            offsuit = [Card(rank=high_rank, suit="hearts"), Card(rank=low_rank, suit="spades")]
            scores[f"{high_rank}{low_rank}s"] = _chart_score(suited)
            scores[f"{high_rank}{low_rank}o"] = _chart_score(offsuit)
    return scores


def _chart_score(cards: list[Card]) -> float:
    score = _starting_hand_score(cards)
    high, low = sorted((14 - RANK_INDEX[card.rank] for card in cards), reverse=True)
    suited = cards[0].suit == cards[1].suit
    if suited and high == 14 and low <= 5:
        score += 12
    if suited and high != low and high - low <= 2:
        score += 6
    return score


def _open_size(effective_stack: float) -> float:
    return round(min(2.5, effective_stack), 2) if effective_stack > 0 else 2.5


def _reraise_size(opener_size: float, pot_size: float, effective_stack: float) -> float:
    target = max(opener_size * 3, pot_size * 1.1)
    return round(min(target, effective_stack), 2)


def _boundary_confidence(top_fraction: float, boundary: float) -> float:
    distance = abs(top_fraction - boundary)
    return round(min(0.84, 0.62 + distance * 0.8), 2)


def _result(
    *,
    action: RecommendationAction,
    sizing: float | None,
    confidence: float,
    hand_class: str,
    top_fraction: float,
    position: Position,
    scenario: str,
    tier: str,
    policy_fraction: float | None,
    assumptions: list[str],
) -> RecommendationResult:
    position_label = POSITION_LABELS[position]
    size_text = f" to {sizing:g} BB" if sizing is not None else ""
    range_text = (
        f" against a {policy_fraction:.0%} chart boundary" if policy_fraction is not None else ""
    )
    assumption_text = " ".join(assumptions)
    if scenario == "big_blind_option":
        actions = ("check", "raise")
    else:
        actions = ("fold", "call", "raise")
    candidates = [
        {
            "action": candidate,
            "sizing": sizing if candidate == action and candidate == "raise" else None,
            "frequency": 1.0 if candidate == action else 0.0,
        }
        for candidate in actions
    ]
    return RecommendationResult(
        action=action,
        sizing=sizing,
        confidence=confidence,
        explanation=(
            f"The position-aware preflop chart recommends {action}{size_text} with {hand_class} "
            f"from {position_label}. Its 169-hand ranking places this hand in the top "
            f"{top_fraction:.1%}{range_text}. {assumption_text} This is a transparent training "
            "chart, not a solved preflop game tree."
        ),
        raw={
            "provider": "local_solver",
            "engine": "preflop_chart_v1",
            "stage": "preflop",
            "hand_class": hand_class,
            "position": position,
            "scenario": scenario,
            "chart_tier": tier,
            "hand_top_fraction": top_fraction,
            "policy_fraction": policy_fraction,
            "ranking_method": "starting_hand_score_with_playability_adjustments",
            "assumptions": assumptions,
            "candidates": candidates,
            "process_boundary": "stdin_stdout_json",
        },
    )
