from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.models import CanonicalState
from app.solvers.preflop_context import (
    MAX_SINGLE_OPEN_SIZE_BB,
    MIN_SINGLE_OPEN_SIZE_BB,
    MONEY_TOLERANCE_BB,
    Position,
    normalize_position,
)


RangeSource = Literal["configured", "preflop_chart_single_raised_pot"]


@dataclass(frozen=True)
class PostflopRangeSelection:
    oop_range: str
    ip_range: str
    source: RangeSource = "configured"
    context: dict[str, str | float] = field(default_factory=dict)


def select_postflop_ranges(
    state: CanonicalState,
    *,
    hero_relative_position: Literal["ip", "oop"] | None,
    configured_oop_range: str,
    configured_ip_range: str,
    contextual_enabled: bool,
) -> PostflopRangeSelection:
    configured = PostflopRangeSelection(
        oop_range=configured_oop_range,
        ip_range=configured_ip_range,
    )
    if (
        not contextual_enabled
        or hero_relative_position is None
        or state.street not in {"flop", "turn", "river"}
    ):
        return configured

    context = _single_raised_pot_context(state)
    if context is None:
        return configured
    opener, caller, opening_size = context

    # Keep provider imports acyclic: preflop_chart depends on rule_based through
    # the provider package, while this resolver is called by the local provider.
    from app.solvers.preflop_chart import (
        DEFENSE_POLICIES,
        POSITION_POLICIES,
        adjusted_defense_policy,
        policy_for_open_size,
        policy_for_stack_depth,
    )

    opener_fraction = POSITION_POLICIES[opener].open_fraction
    base_defense = DEFENSE_POLICIES.get((opener, caller))
    size_policy = policy_for_open_size(opening_size)
    standard_stack_policy = policy_for_stack_depth(100)
    if (
        opener_fraction <= 0
        or base_defense is None
        or size_policy is None
        or standard_stack_policy is None
    ):
        return configured
    defense = adjusted_defense_policy(
        base_defense,
        size_policy,
        standard_stack_policy,
    )

    opener_range = _range_for_policy_band(opener_fraction)
    caller_range = _range_for_policy_band(
        defense.continue_fraction,
        minimum_exclusive=defense.reraise_fraction,
    )
    if not opener_range or not caller_range:
        return configured

    hero_position = normalize_position(state.hero_position)
    opponent_position = normalize_position(state.opponent_position)
    if hero_position is None or opponent_position is None:
        return configured
    ranges_by_position = {
        opener: opener_range,
        caller: caller_range,
    }
    hero_range = ranges_by_position[hero_position]
    opponent_range = ranges_by_position[opponent_position]
    oop_range, ip_range = (
        (hero_range, opponent_range)
        if hero_relative_position == "oop"
        else (opponent_range, hero_range)
    )

    return PostflopRangeSelection(
        oop_range=oop_range,
        ip_range=ip_range,
        source="preflop_chart_single_raised_pot",
        context={
            "scenario": "single_raised_pot",
            "opener_position": opener,
            "caller_position": caller,
            "opening_size_bb": opening_size,
            "open_size_policy": size_policy.name,
            "opener_fraction": opener_fraction,
            "caller_base_continue_fraction": base_defense.continue_fraction,
            "caller_base_reraise_fraction": base_defense.reraise_fraction,
            "caller_continue_fraction": defense.continue_fraction,
            "caller_reraise_fraction": defense.reraise_fraction,
        },
    )


def _single_raised_pot_context(
    state: CanonicalState,
) -> tuple[Position, Position, float] | None:
    if state.players_in_hand != 2 or len(state.preflop_action_history) != 2:
        return None
    opening_action, calling_action = state.preflop_action_history
    if opening_action.action != "raise" or calling_action.action != "call":
        return None
    if (
        abs(opening_action.amount - calling_action.amount) > MONEY_TOLERANCE_BB
        or not MIN_SINGLE_OPEN_SIZE_BB
        <= opening_action.amount
        <= MAX_SINGLE_OPEN_SIZE_BB
    ):
        return None

    opener = normalize_position(opening_action.actor)
    caller = normalize_position(calling_action.actor)
    hero_position = normalize_position(state.hero_position)
    opponent_position = normalize_position(state.opponent_position)
    if (
        opener is None
        or caller is None
        or opener == caller
        or hero_position is None
        or opponent_position is None
        or hero_position == opponent_position
        or {opener, caller} != {hero_position, opponent_position}
    ):
        return None
    if (
        state.preflop_opener_position is not None
        and normalize_position(state.preflop_opener_position) != opener
    ):
        return None
    if (
        state.preflop_open_size is not None
        and abs(state.preflop_open_size - opening_action.amount)
        > MONEY_TOLERANCE_BB
    ):
        return None
    return opener, caller, opening_action.amount


def _range_for_policy_band(
    maximum_fraction: float,
    *,
    minimum_exclusive: float = 0,
) -> str:
    from app.solvers.preflop_chart import hand_classes_in_policy_band

    return ",".join(
        hand_classes_in_policy_band(
            maximum_fraction,
            minimum_exclusive=minimum_exclusive,
        )
    )
