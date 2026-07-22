from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from app.models import Card, RecommendationAction, RecommendationRequest, RecommendationResult
from app.providers.rule_based import _starting_hand_score
from app.solvers.preflop_context import (
    Position,
    normalize_position,
    opening_raise_position,
    resolve_opening_raise_size,
    supports_preflop_chart,
)

RANKS = tuple("AKQJT98765432")
RANK_INDEX = {rank: index for index, rank in enumerate(RANKS)}


@dataclass(frozen=True)
class PositionPolicy:
    open_fraction: float


@dataclass(frozen=True)
class DefensePolicy:
    continue_fraction: float
    reraise_fraction: float


@dataclass(frozen=True)
class OpenSizePolicy:
    name: str
    maximum_size: float
    continue_multiplier: float
    reraise_multiplier: float


@dataclass(frozen=True)
class StackDepthPolicy:
    name: str
    maximum_stack: float | None
    open_multiplier: float
    continue_multiplier: float
    reraise_multiplier: float
    opening_size: float


POSITION_POLICIES: dict[Position, PositionPolicy] = {
    "utg": PositionPolicy(0.17),
    "hijack": PositionPolicy(0.22),
    "cutoff": PositionPolicy(0.30),
    "button": PositionPolicy(0.45),
    "small_blind": PositionPolicy(0.40),
    "big_blind": PositionPolicy(0.0),
}

# Conservative six-max response boundaries keyed by (opener, hero). Later
# openers permit wider continues and reraises, while cold-call-sensitive blind
# matchups remain tighter than big-blind closes-action defense.
DEFENSE_POLICIES: dict[tuple[Position, Position], DefensePolicy] = {
    ("utg", "hijack"): DefensePolicy(0.10, 0.04),
    ("utg", "cutoff"): DefensePolicy(0.12, 0.05),
    ("utg", "button"): DefensePolicy(0.14, 0.05),
    ("utg", "small_blind"): DefensePolicy(0.12, 0.05),
    ("utg", "big_blind"): DefensePolicy(0.20, 0.06),
    ("hijack", "cutoff"): DefensePolicy(0.14, 0.05),
    ("hijack", "button"): DefensePolicy(0.17, 0.06),
    ("hijack", "small_blind"): DefensePolicy(0.14, 0.06),
    ("hijack", "big_blind"): DefensePolicy(0.23, 0.07),
    ("cutoff", "button"): DefensePolicy(0.22, 0.08),
    ("cutoff", "small_blind"): DefensePolicy(0.18, 0.08),
    ("cutoff", "big_blind"): DefensePolicy(0.30, 0.09),
    ("button", "small_blind"): DefensePolicy(0.24, 0.10),
    ("button", "big_blind"): DefensePolicy(0.40, 0.12),
    ("small_blind", "big_blind"): DefensePolicy(0.48, 0.13),
}

# The standard band preserves the 2.5 BB matchup chart. Adjacent bands make
# modest, monotonic changes instead of pretending to solve a continuous tree.
OPEN_SIZE_POLICIES: tuple[OpenSizePolicy, ...] = (
    OpenSizePolicy("small", 2.25, 1.10, 1.05),
    OpenSizePolicy("standard", 2.75, 1.00, 1.00),
    OpenSizePolicy("large", 3.25, 0.90, 0.95),
    OpenSizePolicy("very_large", 4.00, 0.78, 0.90),
)

# Stack bands keep the chart explicit and deterministic. Shorter stacks trim
# speculative opens/calls and move more of the continuing range into reraises.
STACK_DEPTH_POLICIES: tuple[StackDepthPolicy, ...] = (
    StackDepthPolicy("short", 20.0, 0.90, 0.90, 1.30, 2.20),
    StackDepthPolicy("medium", 50.0, 0.95, 0.95, 1.15, 2.30),
    StackDepthPolicy("standard", 150.0, 1.00, 1.00, 1.00, 2.50),
    StackDepthPolicy("deep", None, 1.03, 1.05, 0.90, 2.50),
)

POSITION_LABELS: dict[Position, str] = {
    "utg": "UTG",
    "hijack": "hijack",
    "cutoff": "cutoff",
    "button": "button",
    "small_blind": "small blind",
    "big_blind": "big blind",
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
    stack_policy = policy_for_stack_depth(effective_stack)
    if stack_policy is None:
        return None

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
                    stack_assumption(effective_stack, stack_policy),
                ],
                effective_stack=effective_stack,
                stack_policy=stack_policy,
            )
        open_fraction = adjusted_open_fraction(policy, stack_policy)
        should_open = top_fraction <= open_fraction
        action: RecommendationAction = "raise" if should_open else "fold"
        sizing = _open_size(effective_stack, stack_policy) if should_open else None
        return _result(
            action=action,
            sizing=sizing,
            confidence=_boundary_confidence(top_fraction, open_fraction),
            hand_class=hand_class,
            top_fraction=top_fraction,
            position=position,
            scenario="first_in",
            tier="open" if should_open else "fold",
            policy_fraction=open_fraction,
            assumptions=[
                "The pot is treated as unopened with no limpers or prior hero action.",
                stack_assumption(effective_stack, stack_policy),
                "The chart models a six-max chip-EV training spot before rake.",
            ],
            effective_stack=effective_stack,
            base_open_fraction=policy.open_fraction,
            stack_policy=stack_policy,
        )

    if state.facing_action != "raise":
        return None

    opener_position = opening_raise_position(
        state.action_context,
        state.preflop_opener_position,
    )
    if opener_position is None:
        return None
    base_defense_policy = DEFENSE_POLICIES.get((opener_position, position))
    if base_defense_policy is None:
        return None
    base_opener_open_fraction = POSITION_POLICIES[opener_position].open_fraction
    opener_open_fraction = adjusted_open_fraction(
        POSITION_POLICIES[opener_position],
        stack_policy,
    )
    opener_size = resolve_opening_raise_size(
        action_context=state.action_context,
        explicit_size=state.preflop_open_size,
        amount_to_call=current_bet,
        hero_position=position,
    )
    size_policy = policy_for_open_size(opener_size)
    if size_policy is None:
        return None
    defense_policy = adjusted_defense_policy(
        base_defense_policy,
        size_policy,
        stack_policy,
    )
    reraise_size = _reraise_size(opener_size, state.pot_size or 0, effective_stack)

    can_reraise = (
        effective_stack > current_bet
        and reraise_size > opener_size
        and top_fraction <= defense_policy.reraise_fraction
    )
    if can_reraise:
        action = "raise"
        sizing = reraise_size
        tier = "reraise"
        boundary = defense_policy.reraise_fraction
    elif top_fraction <= defense_policy.continue_fraction:
        action = "call"
        sizing = None
        tier = "defend"
        boundary = defense_policy.continue_fraction
    else:
        action = "fold"
        sizing = None
        tier = "fold"
        boundary = defense_policy.continue_fraction

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
            f"The opening raise is attributed to {POSITION_LABELS[opener_position]}.",
            f"The defense chart uses matchup-specific {POSITION_LABELS[position]}-versus-"
            f"{POSITION_LABELS[opener_position]} boundaries.",
            f"The opener model adjusts the {POSITION_LABELS[opener_position]}'s "
            f"{base_opener_open_fraction:.0%} base first-in range to "
            f"{opener_open_fraction:.1%} for this stack depth.",
            f"The {opener_size:g} BB opening size uses the {size_policy.name.replace('_', ' ')} "
            "open adjustment.",
            stack_assumption(effective_stack, stack_policy),
            "The chart models a six-max chip-EV training spot before rake.",
        ],
        effective_stack=effective_stack,
        opener_position=opener_position,
        base_opener_open_fraction=base_opener_open_fraction,
        opener_open_fraction=opener_open_fraction,
        opening_raise_size=opener_size,
        base_defense_policy=base_defense_policy,
        defense_policy=defense_policy,
        size_policy=size_policy,
        stack_policy=stack_policy,
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


def _open_size(effective_stack: float, stack_policy: StackDepthPolicy) -> float:
    return round(min(stack_policy.opening_size, effective_stack), 2)


def _reraise_size(opener_size: float, pot_size: float, effective_stack: float) -> float:
    target = max(opener_size * 3, pot_size * 1.1)
    return round(min(target, effective_stack), 2)


def _boundary_confidence(top_fraction: float, boundary: float) -> float:
    distance = abs(top_fraction - boundary)
    return round(min(0.84, 0.62 + distance * 0.8), 2)


def policy_for_open_size(opening_size: float) -> OpenSizePolicy | None:
    return next(
        (policy for policy in OPEN_SIZE_POLICIES if opening_size <= policy.maximum_size),
        None,
    )


def policy_for_stack_depth(effective_stack: float) -> StackDepthPolicy | None:
    return next(
        (
            policy
            for policy in STACK_DEPTH_POLICIES
            if policy.maximum_stack is None or effective_stack <= policy.maximum_stack
        ),
        None,
    )


def adjusted_open_fraction(
    position_policy: PositionPolicy,
    stack_policy: StackDepthPolicy,
) -> float:
    return round(
        min(1.0, position_policy.open_fraction * stack_policy.open_multiplier),
        4,
    )


def adjusted_defense_policy(
    base_policy: DefensePolicy,
    size_policy: OpenSizePolicy,
    stack_policy: StackDepthPolicy,
) -> DefensePolicy:
    return DefensePolicy(
        continue_fraction=round(
            min(
                1.0,
                base_policy.continue_fraction
                * size_policy.continue_multiplier
                * stack_policy.continue_multiplier,
            ),
            4,
        ),
        reraise_fraction=round(
            min(
                1.0,
                base_policy.reraise_fraction
                * size_policy.reraise_multiplier
                * stack_policy.reraise_multiplier,
            ),
            4,
        ),
    )


def stack_assumption(
    effective_stack: float,
    stack_policy: StackDepthPolicy,
) -> str:
    return (
        f"The {effective_stack:g} BB effective stack uses the "
        f"{stack_policy.name} stack-depth adjustment."
    )


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
    effective_stack: float | None = None,
    base_open_fraction: float | None = None,
    opener_position: Position | None = None,
    base_opener_open_fraction: float | None = None,
    opener_open_fraction: float | None = None,
    opening_raise_size: float | None = None,
    base_defense_policy: DefensePolicy | None = None,
    defense_policy: DefensePolicy | None = None,
    size_policy: OpenSizePolicy | None = None,
    stack_policy: StackDepthPolicy | None = None,
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
    raw: dict[str, object] = {
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
    }
    if opener_position is not None:
        raw["opener_position"] = opener_position
    if opening_raise_size is not None:
        raw["opening_raise_size"] = opening_raise_size
    if effective_stack is not None and stack_policy is not None:
        raw.update(
            {
                "effective_stack": effective_stack,
                "stack_depth_policy": stack_policy.name,
                "open_stack_multiplier": stack_policy.open_multiplier,
                "continue_stack_multiplier": stack_policy.continue_multiplier,
                "reraise_stack_multiplier": stack_policy.reraise_multiplier,
            }
        )
    if base_open_fraction is not None and stack_policy is not None:
        raw.update(
            {
                "policy_source": "hero_position_stack",
                "base_open_fraction": base_open_fraction,
                "open_fraction": policy_fraction,
                "target_open_size": stack_policy.opening_size,
            }
        )
    if (
        opener_position is not None
        and base_opener_open_fraction is not None
        and opener_open_fraction is not None
        and base_defense_policy is not None
        and defense_policy is not None
        and size_policy is not None
        and stack_policy is not None
    ):
        raw.update(
            {
                "policy_source": "hero_opener_size_stack_matchup",
                "base_opener_open_fraction": base_opener_open_fraction,
                "opener_open_fraction": opener_open_fraction,
                "base_continue_fraction": base_defense_policy.continue_fraction,
                "base_reraise_fraction": base_defense_policy.reraise_fraction,
                "continue_fraction": defense_policy.continue_fraction,
                "reraise_fraction": defense_policy.reraise_fraction,
                "open_size_policy": size_policy.name,
                "continue_size_multiplier": size_policy.continue_multiplier,
                "reraise_size_multiplier": size_policy.reraise_multiplier,
            }
        )

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
        raw=raw,
    )
