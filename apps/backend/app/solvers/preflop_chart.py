from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from app.models import Card, RecommendationAction, RecommendationRequest, RecommendationResult
from app.providers.rule_based import _starting_hand_score
from app.solvers.preflop_context import (
    POSTED_BLIND_BB,
    PreflopChartContext,
    Position,
    normalize_position,
    resolve_preflop_chart_context,
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
class ThreeBetDefensePolicy:
    continue_fraction: float
    four_bet_fraction: float


@dataclass(frozen=True)
class OpenSizePolicy:
    name: str
    maximum_size: float
    continue_multiplier: float
    reraise_multiplier: float


@dataclass(frozen=True)
class ThreeBetSizePolicy:
    name: str
    maximum_ratio: float
    continue_multiplier: float
    four_bet_multiplier: float


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

# Hero-open responses to one later-position 3-bet. Fractions are shares of all
# starting hands, not shares of the opening range, which keeps them comparable
# with the chart's existing 169-class ranking.
THREE_BET_DEFENSE_POLICIES: dict[
    tuple[Position, Position], ThreeBetDefensePolicy
] = {
    ("utg", "hijack"): ThreeBetDefensePolicy(0.075, 0.025),
    ("utg", "cutoff"): ThreeBetDefensePolicy(0.080, 0.030),
    ("utg", "button"): ThreeBetDefensePolicy(0.085, 0.030),
    ("utg", "small_blind"): ThreeBetDefensePolicy(0.090, 0.035),
    ("utg", "big_blind"): ThreeBetDefensePolicy(0.095, 0.035),
    ("hijack", "cutoff"): ThreeBetDefensePolicy(0.090, 0.035),
    ("hijack", "button"): ThreeBetDefensePolicy(0.100, 0.040),
    ("hijack", "small_blind"): ThreeBetDefensePolicy(0.105, 0.040),
    ("hijack", "big_blind"): ThreeBetDefensePolicy(0.110, 0.045),
    ("cutoff", "button"): ThreeBetDefensePolicy(0.120, 0.045),
    ("cutoff", "small_blind"): ThreeBetDefensePolicy(0.130, 0.050),
    ("cutoff", "big_blind"): ThreeBetDefensePolicy(0.135, 0.050),
    ("button", "small_blind"): ThreeBetDefensePolicy(0.160, 0.060),
    ("button", "big_blind"): ThreeBetDefensePolicy(0.180, 0.065),
    ("small_blind", "big_blind"): ThreeBetDefensePolicy(0.200, 0.070),
}

# The standard band preserves the 2.5 BB matchup chart. Adjacent bands make
# modest, monotonic changes instead of pretending to solve a continuous tree.
OPEN_SIZE_POLICIES: tuple[OpenSizePolicy, ...] = (
    OpenSizePolicy("small", 2.25, 1.10, 1.05),
    OpenSizePolicy("standard", 2.75, 1.00, 1.00),
    OpenSizePolicy("large", 3.25, 0.90, 0.95),
    OpenSizePolicy("very_large", 4.00, 0.78, 0.90),
)

THREE_BET_SIZE_POLICIES: tuple[ThreeBetSizePolicy, ...] = (
    ThreeBetSizePolicy("small", 2.75, 1.05, 1.05),
    ThreeBetSizePolicy("standard", 3.50, 1.00, 1.00),
    ThreeBetSizePolicy("large", 4.25, 0.90, 0.95),
    ThreeBetSizePolicy("very_large", 5.00, 0.80, 0.90),
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
    context = resolve_preflop_chart_context(request)
    if context is None:
        return None

    position = context.hero_position

    hand_class = canonical_hand_class(state.hero_cards)
    top_fraction = hand_top_fraction(state.hero_cards)
    policy = POSITION_POLICIES[position]
    effective_stack = state.effective_stack or 0
    stack_policy = policy_for_stack_depth(effective_stack)
    if stack_policy is None:
        return None

    if context.scenario in {"first_in", "big_blind_option"}:
        if (state.pot_size or 0) > 2.5:
            return None
        if context.scenario == "big_blind_option":
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

    if context.scenario == "facing_three_bet":
        return _solve_facing_three_bet(
            request=request,
            context=context,
            hand_class=hand_class,
            top_fraction=top_fraction,
            stack_policy=stack_policy,
        )

    opener_position = context.opener_position
    opener_size = context.opening_raise_size
    if opener_position is None or opener_size is None:
        return None
    base_defense_policy = DEFENSE_POLICIES.get((opener_position, position))
    if base_defense_policy is None:
        return None
    base_opener_open_fraction = POSITION_POLICIES[opener_position].open_fraction
    opener_open_fraction = adjusted_open_fraction(
        POSITION_POLICIES[opener_position],
        stack_policy,
    )
    size_policy = policy_for_open_size(opener_size)
    if size_policy is None:
        return None
    defense_policy = adjusted_defense_policy(
        base_defense_policy,
        size_policy,
        stack_policy,
    )
    maximum_reraise_total = _maximum_reraise_total(
        effective_stack=effective_stack,
        hero_stack=state.hero_stack,
        hero_position=position,
        opener_size=opener_size,
    )
    reraise_size = _reraise_size(
        opener_size,
        state.pot_size or 0,
        maximum_reraise_total,
    )

    can_reraise = (
        reraise_size > opener_size
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
            "The approved state represents one open raise with no callers or prior hero action.",
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
        maximum_reraise_total=maximum_reraise_total,
        base_defense_policy=base_defense_policy,
        defense_policy=defense_policy,
        size_policy=size_policy,
        stack_policy=stack_policy,
    )


def _solve_facing_three_bet(
    *,
    request: RecommendationRequest,
    context: PreflopChartContext,
    hand_class: str,
    top_fraction: float,
    stack_policy: StackDepthPolicy,
) -> RecommendationResult | None:
    state = request.state
    hero_position = context.hero_position
    three_bettor_position = context.latest_aggressor_position
    opener_size = context.opening_raise_size
    three_bet_size = context.latest_raise_size
    if (
        three_bettor_position is None
        or opener_size is None
        or three_bet_size is None
        or state.hero_stack is None
        or state.effective_stack is None
    ):
        return None
    base_policy = THREE_BET_DEFENSE_POLICIES.get(
        (hero_position, three_bettor_position)
    )
    if base_policy is None:
        return None
    size_policy = policy_for_three_bet_size(three_bet_size / opener_size)
    if size_policy is None:
        return None
    defense_policy = adjusted_three_bet_defense_policy(
        base_policy,
        size_policy,
        stack_policy,
    )
    maximum_four_bet_total = min(
        state.hero_stack + opener_size,
        state.effective_stack + three_bet_size,
    )
    four_bet_size = round(
        min(
            max(three_bet_size * 2.2, (state.pot_size or 0) * 0.9),
            maximum_four_bet_total,
        ),
        2,
    )
    can_four_bet = (
        four_bet_size > three_bet_size
        and top_fraction <= defense_policy.four_bet_fraction
    )
    if can_four_bet:
        action: RecommendationAction = "raise"
        sizing = four_bet_size
        tier = "four_bet"
        boundary = defense_policy.four_bet_fraction
    elif top_fraction <= defense_policy.continue_fraction:
        action = "call"
        sizing = None
        tier = "continue"
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
        position=hero_position,
        scenario="facing_three_bet",
        tier=tier,
        policy_fraction=boundary,
        assumptions=[
            "The structured preflop history contains one hero open and one later-position 3-bet with no callers.",
            f"The 3-bet is attributed to {POSITION_LABELS[three_bettor_position]}.",
            f"The chart uses matchup-specific {POSITION_LABELS[hero_position]}-versus-"
            f"{POSITION_LABELS[three_bettor_position]} 3-bet defense boundaries.",
            f"The {three_bet_size:g} BB 3-bet is {three_bet_size / opener_size:.2f}x the open "
            f"and uses the {size_policy.name.replace('_', ' ')} size adjustment.",
            stack_assumption(state.effective_stack, stack_policy),
            "The chart models a six-max chip-EV training spot before rake.",
        ],
        effective_stack=state.effective_stack,
        opener_position=hero_position,
        opening_raise_size=opener_size,
        three_bettor_position=three_bettor_position,
        three_bet_size=three_bet_size,
        maximum_four_bet_total=maximum_four_bet_total,
        base_three_bet_defense_policy=base_policy,
        three_bet_defense_policy=defense_policy,
        three_bet_size_policy=size_policy,
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


def _maximum_reraise_total(
    *,
    effective_stack: float,
    hero_stack: float | None,
    hero_position: Position,
    opener_size: float,
) -> float:
    hero_blind = POSTED_BLIND_BB[hero_position]
    if hero_stack is None:
        return effective_stack + hero_blind
    hero_total = hero_stack + hero_blind
    opponent_total = effective_stack + opener_size
    return min(hero_total, opponent_total)


def _reraise_size(opener_size: float, pot_size: float, maximum_total: float) -> float:
    target = max(opener_size * 3, pot_size * 1.1)
    return round(min(target, maximum_total), 2)


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


def policy_for_three_bet_size(
    three_bet_to_open_ratio: float,
) -> ThreeBetSizePolicy | None:
    return next(
        (
            policy
            for policy in THREE_BET_SIZE_POLICIES
            if three_bet_to_open_ratio <= policy.maximum_ratio
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


def adjusted_three_bet_defense_policy(
    base_policy: ThreeBetDefensePolicy,
    size_policy: ThreeBetSizePolicy,
    stack_policy: StackDepthPolicy,
) -> ThreeBetDefensePolicy:
    return ThreeBetDefensePolicy(
        continue_fraction=round(
            min(
                1.0,
                base_policy.continue_fraction
                * size_policy.continue_multiplier
                * stack_policy.continue_multiplier,
            ),
            4,
        ),
        four_bet_fraction=round(
            min(
                1.0,
                base_policy.four_bet_fraction
                * size_policy.four_bet_multiplier
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
    maximum_reraise_total: float | None = None,
    three_bettor_position: Position | None = None,
    three_bet_size: float | None = None,
    maximum_four_bet_total: float | None = None,
    base_defense_policy: DefensePolicy | None = None,
    defense_policy: DefensePolicy | None = None,
    size_policy: OpenSizePolicy | None = None,
    base_three_bet_defense_policy: ThreeBetDefensePolicy | None = None,
    three_bet_defense_policy: ThreeBetDefensePolicy | None = None,
    three_bet_size_policy: ThreeBetSizePolicy | None = None,
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
    if maximum_reraise_total is not None:
        raw["maximum_reraise_total"] = maximum_reraise_total
    if three_bettor_position is not None:
        raw["three_bettor_position"] = three_bettor_position
    if three_bet_size is not None:
        raw["three_bet_size"] = three_bet_size
        if opening_raise_size is not None:
            raw["three_bet_to_open_ratio"] = round(
                three_bet_size / opening_raise_size,
                4,
            )
    if maximum_four_bet_total is not None:
        raw["maximum_four_bet_total"] = maximum_four_bet_total
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
    if (
        three_bettor_position is not None
        and base_three_bet_defense_policy is not None
        and three_bet_defense_policy is not None
        and three_bet_size_policy is not None
        and stack_policy is not None
    ):
        raw.update(
            {
                "policy_source": "hero_three_bettor_size_stack_matchup",
                "base_continue_fraction": (
                    base_three_bet_defense_policy.continue_fraction
                ),
                "base_four_bet_fraction": (
                    base_three_bet_defense_policy.four_bet_fraction
                ),
                "continue_fraction": three_bet_defense_policy.continue_fraction,
                "four_bet_fraction": three_bet_defense_policy.four_bet_fraction,
                "three_bet_size_policy": three_bet_size_policy.name,
                "continue_size_multiplier": (
                    three_bet_size_policy.continue_multiplier
                ),
                "four_bet_size_multiplier": (
                    three_bet_size_policy.four_bet_multiplier
                ),
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
