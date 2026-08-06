from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.models import CanonicalState
from app.solvers.preflop_context import (
    MAX_SUPPORTED_FOUR_BET_TO_THREE_BET_RATIO,
    MAX_SUPPORTED_THREE_BET_TO_OPEN_RATIO,
    MAX_SINGLE_OPEN_SIZE_BB,
    MIN_SINGLE_OPEN_SIZE_BB,
    MONEY_TOLERANCE_BB,
    POSITION_ACTION_ORDER,
    Position,
    normalize_position,
    pot_matches_preflop_actions,
)


RangeSource = Literal[
    "configured",
    "preflop_chart_single_raised_pot",
    "preflop_chart_three_bet_pot",
    "preflop_chart_four_bet_pot",
]


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
        or state.street != "flop"
    ):
        return configured

    single_raised_context = _single_raised_pot_context(state)
    if single_raised_context is not None:
        selection = _single_raised_pot_selection(
            state,
            hero_relative_position,
            single_raised_context,
        )
        if selection is not None:
            return selection

    three_bet_context = _three_bet_pot_context(state)
    if three_bet_context is not None:
        selection = _three_bet_pot_selection(
            state,
            hero_relative_position,
            three_bet_context,
        )
        if selection is not None:
            return selection

    four_bet_context = _four_bet_pot_context(state)
    if four_bet_context is not None:
        selection = _four_bet_pot_selection(
            state,
            hero_relative_position,
            four_bet_context,
        )
        if selection is not None:
            return selection
    return configured


def _single_raised_pot_selection(
    state: CanonicalState,
    hero_relative_position: Literal["ip", "oop"],
    context: tuple[Position, Position, float],
) -> PostflopRangeSelection | None:
    opener, caller, opening_size = context
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
        return None
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
        return None

    return _selection_for_ranges(
        state,
        hero_relative_position,
        ranges_by_position={opener: opener_range, caller: caller_range},
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


def _three_bet_pot_selection(
    state: CanonicalState,
    hero_relative_position: Literal["ip", "oop"],
    context: tuple[Position, Position, float, float],
) -> PostflopRangeSelection | None:
    opener, three_bettor, opening_size, three_bet_size = context
    # Keep provider imports acyclic: preflop_chart depends on rule_based through
    # the provider package, while this resolver is called by the local provider.
    from app.solvers.preflop_chart import (
        DEFENSE_POLICIES,
        THREE_BET_DEFENSE_POLICIES,
        adjusted_defense_policy,
        adjusted_three_bet_defense_policy,
        policy_for_open_size,
        policy_for_stack_depth,
        policy_for_three_bet_size,
    )

    base_three_bettor = DEFENSE_POLICIES.get((opener, three_bettor))
    base_opener = THREE_BET_DEFENSE_POLICIES.get((opener, three_bettor))
    open_size_policy = policy_for_open_size(opening_size)
    three_bet_size_policy = policy_for_three_bet_size(
        three_bet_size / opening_size
    )
    standard_stack_policy = policy_for_stack_depth(100)
    if (
        base_three_bettor is None
        or base_opener is None
        or open_size_policy is None
        or three_bet_size_policy is None
        or standard_stack_policy is None
    ):
        return None

    three_bettor_policy = adjusted_defense_policy(
        base_three_bettor,
        open_size_policy,
        standard_stack_policy,
    )
    opener_policy = adjusted_three_bet_defense_policy(
        base_opener,
        three_bet_size_policy,
        standard_stack_policy,
    )
    three_bettor_range = _range_for_policy_band(
        three_bettor_policy.reraise_fraction
    )
    opener_call_range = _range_for_policy_band(
        opener_policy.continue_fraction,
        minimum_exclusive=opener_policy.four_bet_fraction,
    )
    if not three_bettor_range or not opener_call_range:
        return None

    return _selection_for_ranges(
        state,
        hero_relative_position,
        ranges_by_position={
            opener: opener_call_range,
            three_bettor: three_bettor_range,
        },
        source="preflop_chart_three_bet_pot",
        context={
            "scenario": "three_bet_pot",
            "opener_position": opener,
            "three_bettor_position": three_bettor,
            "opening_size_bb": opening_size,
            "three_bet_size_bb": three_bet_size,
            "open_size_policy": open_size_policy.name,
            "three_bet_size_policy": three_bet_size_policy.name,
            "three_bettor_base_fraction": base_three_bettor.reraise_fraction,
            "three_bettor_fraction": three_bettor_policy.reraise_fraction,
            "opener_base_continue_fraction": base_opener.continue_fraction,
            "opener_base_four_bet_fraction": base_opener.four_bet_fraction,
            "opener_continue_fraction": opener_policy.continue_fraction,
            "opener_four_bet_fraction": opener_policy.four_bet_fraction,
        },
    )


def _four_bet_pot_selection(
    state: CanonicalState,
    hero_relative_position: Literal["ip", "oop"],
    context: tuple[Position, Position, float, float, float],
) -> PostflopRangeSelection | None:
    opener, three_bettor, opening_size, three_bet_size, four_bet_size = context
    from app.solvers.preflop_chart import (
        FOUR_BET_DEFENSE_POLICIES,
        THREE_BET_DEFENSE_POLICIES,
        adjusted_four_bet_defense_policy,
        adjusted_three_bet_defense_policy,
        policy_for_four_bet_size,
        policy_for_stack_depth,
        policy_for_three_bet_size,
    )

    base_opener = THREE_BET_DEFENSE_POLICIES.get((opener, three_bettor))
    base_three_bettor = FOUR_BET_DEFENSE_POLICIES.get((opener, three_bettor))
    three_bet_size_policy = policy_for_three_bet_size(
        three_bet_size / opening_size
    )
    four_bet_size_policy = policy_for_four_bet_size(
        four_bet_size / three_bet_size
    )
    standard_stack_policy = policy_for_stack_depth(100)
    if (
        base_opener is None
        or base_three_bettor is None
        or three_bet_size_policy is None
        or four_bet_size_policy is None
        or standard_stack_policy is None
    ):
        return None

    opener_policy = adjusted_three_bet_defense_policy(
        base_opener,
        three_bet_size_policy,
        standard_stack_policy,
    )
    three_bettor_policy = adjusted_four_bet_defense_policy(
        base_three_bettor,
        four_bet_size_policy,
        standard_stack_policy,
    )
    opener_four_bet_range = _range_for_policy_band(
        opener_policy.four_bet_fraction
    )
    three_bettor_call_range = _range_for_policy_band(
        three_bettor_policy.continue_fraction,
        minimum_exclusive=three_bettor_policy.five_bet_fraction,
    )
    if not opener_four_bet_range or not three_bettor_call_range:
        return None

    return _selection_for_ranges(
        state,
        hero_relative_position,
        ranges_by_position={
            opener: opener_four_bet_range,
            three_bettor: three_bettor_call_range,
        },
        source="preflop_chart_four_bet_pot",
        context={
            "scenario": "four_bet_pot",
            "opener_position": opener,
            "three_bettor_position": three_bettor,
            "opening_size_bb": opening_size,
            "three_bet_size_bb": three_bet_size,
            "four_bet_size_bb": four_bet_size,
            "three_bet_size_policy": three_bet_size_policy.name,
            "four_bet_size_policy": four_bet_size_policy.name,
            "opener_base_four_bet_fraction": base_opener.four_bet_fraction,
            "opener_four_bet_fraction": opener_policy.four_bet_fraction,
            "three_bettor_base_continue_fraction": (
                base_three_bettor.continue_fraction
            ),
            "three_bettor_base_five_bet_fraction": (
                base_three_bettor.five_bet_fraction
            ),
            "three_bettor_continue_fraction": (
                three_bettor_policy.continue_fraction
            ),
            "three_bettor_five_bet_fraction": (
                three_bettor_policy.five_bet_fraction
            ),
        },
    )


def _selection_for_ranges(
    state: CanonicalState,
    hero_relative_position: Literal["ip", "oop"],
    *,
    ranges_by_position: dict[Position, str],
    source: RangeSource,
    context: dict[str, str | float],
) -> PostflopRangeSelection | None:
    hero_position = normalize_position(state.hero_position)
    opponent_position = normalize_position(state.opponent_position)
    if (
        hero_position not in ranges_by_position
        or opponent_position not in ranges_by_position
    ):
        return None
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
        source=source,
        context=context,
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
    flop_root_pot = _flop_root_pot(state)
    if not pot_matches_preflop_actions(
        flop_root_pot,
        (
            (opener, opening_action.amount),
            (caller, calling_action.amount),
        ),
    ):
        return None
    return opener, caller, opening_action.amount


def _three_bet_pot_context(
    state: CanonicalState,
) -> tuple[Position, Position, float, float] | None:
    if state.players_in_hand != 2 or len(state.preflop_action_history) != 3:
        return None
    opening_action, three_bet_action, calling_action = (
        state.preflop_action_history
    )
    if (
        opening_action.action != "raise"
        or three_bet_action.action != "raise"
        or calling_action.action != "call"
        or calling_action.actor != opening_action.actor
        or abs(calling_action.amount - three_bet_action.amount)
        > MONEY_TOLERANCE_BB
        or not MIN_SINGLE_OPEN_SIZE_BB
        <= opening_action.amount
        <= MAX_SINGLE_OPEN_SIZE_BB
    ):
        return None

    opener = normalize_position(opening_action.actor)
    three_bettor = normalize_position(three_bet_action.actor)
    hero_position = normalize_position(state.hero_position)
    opponent_position = normalize_position(state.opponent_position)
    minimum_full_raise = opening_action.amount + max(
        1.0,
        opening_action.amount - 1.0,
    )
    if (
        opener is None
        or three_bettor is None
        or opener == three_bettor
        or hero_position is None
        or opponent_position is None
        or hero_position == opponent_position
        or {opener, three_bettor} != {hero_position, opponent_position}
        or POSITION_ACTION_ORDER[opener]
        >= POSITION_ACTION_ORDER[three_bettor]
        or three_bet_action.amount + MONEY_TOLERANCE_BB < minimum_full_raise
        or three_bet_action.amount
        > opening_action.amount * MAX_SUPPORTED_THREE_BET_TO_OPEN_RATIO
        + MONEY_TOLERANCE_BB
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
    flop_root_pot = _flop_root_pot(state)
    if not pot_matches_preflop_actions(
        flop_root_pot,
        (
            (opener, calling_action.amount),
            (three_bettor, three_bet_action.amount),
        ),
    ):
        return None
    return (
        opener,
        three_bettor,
        opening_action.amount,
        three_bet_action.amount,
    )


def _four_bet_pot_context(
    state: CanonicalState,
) -> tuple[Position, Position, float, float, float] | None:
    if state.players_in_hand != 2 or len(state.preflop_action_history) != 4:
        return None
    opening_action, three_bet_action, four_bet_action, calling_action = (
        state.preflop_action_history
    )
    if (
        opening_action.action != "raise"
        or three_bet_action.action != "raise"
        or four_bet_action.action != "raise"
        or calling_action.action != "call"
        or four_bet_action.actor != opening_action.actor
        or calling_action.actor != three_bet_action.actor
        or abs(calling_action.amount - four_bet_action.amount)
        > MONEY_TOLERANCE_BB
        or not MIN_SINGLE_OPEN_SIZE_BB
        <= opening_action.amount
        <= MAX_SINGLE_OPEN_SIZE_BB
    ):
        return None

    opener = normalize_position(opening_action.actor)
    three_bettor = normalize_position(three_bet_action.actor)
    hero_position = normalize_position(state.hero_position)
    opponent_position = normalize_position(state.opponent_position)
    minimum_three_bet = opening_action.amount + max(
        1.0,
        opening_action.amount - 1.0,
    )
    minimum_four_bet = three_bet_action.amount + (
        three_bet_action.amount - opening_action.amount
    )
    if (
        opener is None
        or three_bettor is None
        or opener == three_bettor
        or hero_position is None
        or opponent_position is None
        or hero_position == opponent_position
        or {opener, three_bettor} != {hero_position, opponent_position}
        or POSITION_ACTION_ORDER[opener]
        >= POSITION_ACTION_ORDER[three_bettor]
        or three_bet_action.amount + MONEY_TOLERANCE_BB < minimum_three_bet
        or three_bet_action.amount
        > opening_action.amount * MAX_SUPPORTED_THREE_BET_TO_OPEN_RATIO
        + MONEY_TOLERANCE_BB
        or four_bet_action.amount + MONEY_TOLERANCE_BB < minimum_four_bet
        or four_bet_action.amount
        > three_bet_action.amount * MAX_SUPPORTED_FOUR_BET_TO_THREE_BET_RATIO
        + MONEY_TOLERANCE_BB
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
    flop_root_pot = _flop_root_pot(state)
    if not pot_matches_preflop_actions(
        flop_root_pot,
        (
            (opener, four_bet_action.amount),
            (three_bettor, calling_action.amount),
        ),
    ):
        return None
    return (
        opener,
        three_bettor,
        opening_action.amount,
        three_bet_action.amount,
        four_bet_action.amount,
    )


def _flop_root_pot(state: CanonicalState) -> float | None:
    if state.street != "flop" or state.pot_size is None:
        return None
    if state.postflop_action_history:
        contributions = {"oop": 0.0, "ip": 0.0}
        for action in state.postflop_action_history:
            if action.amount is not None:
                contributions[action.actor] = action.amount
        root_pot = state.pot_size - sum(contributions.values())
    elif (state.current_bet or 0) > 0:
        if state.facing_action != "bet":
            return None
        root_pot = state.pot_size - (state.current_bet or 0)
    else:
        if state.facing_action is not None:
            return None
        root_pot = state.pot_size
    return root_pot if root_pot > 0 else None


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
