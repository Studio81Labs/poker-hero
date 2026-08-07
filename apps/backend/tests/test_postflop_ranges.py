from __future__ import annotations

import pytest

from app.config import DEFAULT_POSTFLOP_IP_RANGE, DEFAULT_POSTFLOP_OOP_RANGE
from app.models import (
    CanonicalState,
    CompletedPostflopAction,
    CompletedPostflopStreetHistory,
    PostflopAction,
    PreflopAction,
)
from app.solvers.preflop_context import POSTED_BLIND_BB, Position
from app.solvers.postflop_ranges import select_postflop_ranges
from app.solvers.preflop_chart import (
    COLD_THREE_BET_DEFENSE_POLICIES,
    FOUR_BET_DEFENSE_POLICIES,
    THREE_BET_DEFENSE_POLICIES,
    hand_classes_in_policy_band,
)


def single_raised_pot_state(*, hero_position: str = "big_blind") -> CanonicalState:
    opponent_position = "button" if hero_position == "big_blind" else "big_blind"
    return CanonicalState(
        players_in_hand=2,
        hero_position=hero_position,
        opponent_position=opponent_position,
        street="flop",
        pot_size=5.5,
        current_bet=0,
        effective_stack=97.5,
        preflop_action_history=[
            PreflopAction(actor="button", action="raise", amount=2.5),
            PreflopAction(actor="big_blind", action="call", amount=2.5),
        ],
    )


def three_bet_pot_state(*, hero_position: str = "button") -> CanonicalState:
    opponent_position = "big_blind" if hero_position == "button" else "button"
    return CanonicalState(
        players_in_hand=2,
        hero_position=hero_position,
        opponent_position=opponent_position,
        street="flop",
        pot_size=16.5,
        current_bet=0,
        effective_stack=92.0,
        preflop_action_history=[
            PreflopAction(actor="button", action="raise", amount=2.5),
            PreflopAction(actor="big_blind", action="raise", amount=8.0),
            PreflopAction(actor="button", action="call", amount=8.0),
        ],
    )


def cold_three_bet_pot_state(
    *,
    hero_position: str = "button",
) -> CanonicalState:
    opponent_position = "cutoff" if hero_position == "button" else "button"
    return CanonicalState(
        players_in_hand=2,
        hero_position=hero_position,
        opponent_position=opponent_position,
        street="flop",
        pot_size=20.0,
        current_bet=0,
        effective_stack=92.0,
        preflop_action_history=[
            PreflopAction(actor="utg", action="raise", amount=2.5),
            PreflopAction(actor="cutoff", action="raise", amount=8.0),
            PreflopAction(actor="button", action="call", amount=8.0),
        ],
    )


def four_bet_pot_state(*, hero_position: str = "button") -> CanonicalState:
    opponent_position = "big_blind" if hero_position == "button" else "button"
    return CanonicalState(
        players_in_hand=2,
        hero_position=hero_position,
        opponent_position=opponent_position,
        street="flop",
        pot_size=40.5,
        current_bet=0,
        effective_stack=80.0,
        preflop_action_history=[
            PreflopAction(actor="button", action="raise", amount=2.5),
            PreflopAction(actor="big_blind", action="raise", amount=8.0),
            PreflopAction(actor="button", action="raise", amount=20.0),
            PreflopAction(actor="big_blind", action="call", amount=20.0),
        ],
    )


def select(state: CanonicalState, *, contextual_enabled: bool = True):
    return select_postflop_ranges(
        state,
        hero_relative_position=(
            "oop" if state.hero_position == "big_blind" else "ip"
        ),
        configured_oop_range=DEFAULT_POSTFLOP_OOP_RANGE,
        configured_ip_range=DEFAULT_POSTFLOP_IP_RANGE,
        contextual_enabled=contextual_enabled,
    )


def test_selects_chart_ranges_for_heads_up_single_raised_pot() -> None:
    selection = select(single_raised_pot_state())

    assert selection.source == "preflop_chart_single_raised_pot"
    assert selection.context == {
        "scenario": "single_raised_pot",
        "opener_position": "button",
        "caller_position": "big_blind",
        "opening_size_bb": 2.5,
        "open_size_policy": "standard",
        "stack_depth_policy": "standard",
        "starting_effective_stack_bb": 100.0,
        "stack_depth_source": "reconstructed",
        "opener_base_fraction": 0.45,
        "opener_fraction": 0.45,
        "caller_base_continue_fraction": 0.4,
        "caller_base_reraise_fraction": 0.12,
        "caller_continue_fraction": 0.4,
        "caller_reraise_fraction": 0.12,
    }
    assert "AA" in selection.ip_range.split(",")
    assert "AA" not in selection.oop_range.split(",")
    assert selection.ip_range != DEFAULT_POSTFLOP_IP_RANGE
    assert selection.oop_range != DEFAULT_POSTFLOP_OOP_RANGE


def test_assigns_contextual_ranges_by_relative_position() -> None:
    caller_hero = select(single_raised_pot_state(hero_position="big_blind"))
    opener_hero = select(single_raised_pot_state(hero_position="button"))

    assert opener_hero.ip_range == caller_hero.ip_range
    assert opener_hero.oop_range == caller_hero.oop_range


def test_selects_single_raised_ranges_on_turn_after_completed_flop() -> None:
    state = single_raised_pot_state()
    state.street = "turn"
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(actor="oop", action="check"),
                CompletedPostflopAction(actor="ip", action="check"),
            ],
        )
    ]

    selection = select(state)

    assert selection.source == "preflop_chart_single_raised_pot"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"
    assert selection.context["decision_street"] == "turn"
    assert selection.context["completed_street_count"] == 1.0


def test_reconstructs_turn_range_depth_after_flop_bet_call() -> None:
    state = single_raised_pot_state()
    state.street = "turn"
    state.pot_size = 9.5
    state.hero_stack = 95.5
    state.opponent_stack = 95.5
    state.effective_stack = 95.5
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(
                    actor="oop",
                    action="bet",
                    amount=2.0,
                ),
                CompletedPostflopAction(
                    actor="ip",
                    action="call",
                    amount=2.0,
                ),
            ],
        )
    ]

    selection = select(state)

    assert selection.source == "preflop_chart_single_raised_pot"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"
    assert selection.context["decision_street"] == "turn"
    assert selection.context["completed_street_count"] == 1.0


def test_selects_single_raised_ranges_on_river_after_exact_prior_streets() -> None:
    state = single_raised_pot_state()
    state.street = "river"
    state.pot_size = 11.5
    state.hero_stack = 94.5
    state.opponent_stack = 94.5
    state.effective_stack = 94.5
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(actor="oop", action="check"),
                CompletedPostflopAction(actor="ip", action="check"),
            ],
        ),
        CompletedPostflopStreetHistory(
            street="turn",
            actions=[
                CompletedPostflopAction(
                    actor="oop",
                    action="bet",
                    amount=3.0,
                ),
                CompletedPostflopAction(
                    actor="ip",
                    action="call",
                    amount=3.0,
                ),
            ],
        ),
    ]

    selection = select(state)

    assert selection.source == "preflop_chart_single_raised_pot"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"
    assert selection.context["decision_street"] == "river"
    assert selection.context["completed_street_count"] == 2.0


def test_selects_turn_ranges_while_facing_a_current_street_bet() -> None:
    state = single_raised_pot_state()
    state.street = "turn"
    state.pot_size = 11.5
    state.current_bet = 2.0
    state.facing_action = "bet"
    state.hero_stack = 95.5
    state.opponent_stack = 93.5
    state.effective_stack = 93.5
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(
                    actor="oop",
                    action="bet",
                    amount=2.0,
                ),
                CompletedPostflopAction(
                    actor="ip",
                    action="call",
                    amount=2.0,
                ),
            ],
        )
    ]
    state.postflop_action_history = [
        PostflopAction(actor="oop", action="check"),
        PostflopAction(actor="ip", action="bet", amount=2.0),
    ]

    selection = select(state)

    assert selection.source == "preflop_chart_single_raised_pot"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"


def test_keeps_configured_ranges_for_incomplete_river_history() -> None:
    state = single_raised_pot_state()
    state.street = "river"
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(actor="oop", action="check"),
                CompletedPostflopAction(actor="ip", action="check"),
            ],
        )
    ]

    selection = select(state)

    assert selection.source == "configured"


def test_keeps_configured_ranges_for_contradictory_completed_street_pot() -> None:
    state = single_raised_pot_state()
    state.street = "turn"
    state.pot_size = 10.5
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(
                    actor="oop",
                    action="bet",
                    amount=2.0,
                ),
                CompletedPostflopAction(
                    actor="ip",
                    action="call",
                    amount=2.0,
                ),
            ],
        )
    ]

    selection = select(state)

    assert selection.source == "configured"


def test_selects_chart_ranges_for_heads_up_three_bet_pot() -> None:
    selection = select(three_bet_pot_state())

    assert selection.source == "preflop_chart_three_bet_pot"
    assert selection.context == {
        "scenario": "three_bet_pot",
        "opener_position": "button",
        "three_bettor_position": "big_blind",
        "opening_size_bb": 2.5,
        "three_bet_size_bb": 8.0,
        "open_size_policy": "standard",
        "three_bet_size_policy": "standard",
        "stack_depth_policy": "standard",
        "starting_effective_stack_bb": 100.0,
        "stack_depth_source": "reconstructed",
        "three_bettor_base_fraction": 0.12,
        "three_bettor_fraction": 0.12,
        "opener_base_continue_fraction": 0.18,
        "opener_base_four_bet_fraction": 0.065,
        "opener_continue_fraction": 0.18,
        "opener_four_bet_fraction": 0.065,
    }
    assert "AA" in selection.oop_range.split(",")
    assert "AA" not in selection.ip_range.split(",")
    assert selection.ip_range != DEFAULT_POSTFLOP_IP_RANGE
    assert selection.oop_range != DEFAULT_POSTFLOP_OOP_RANGE


def test_assigns_three_bet_ranges_by_relative_position() -> None:
    opener_hero = select(three_bet_pot_state(hero_position="button"))
    three_bettor_hero = select(
        three_bet_pot_state(hero_position="big_blind")
    )

    assert opener_hero.ip_range == three_bettor_hero.ip_range
    assert opener_hero.oop_range == three_bettor_hero.oop_range


@pytest.mark.parametrize(
    ("opener", "three_bettor"),
    sorted(THREE_BET_DEFENSE_POLICIES),
)
def test_supports_every_charted_three_bet_matchup(
    opener: Position,
    three_bettor: Position,
) -> None:
    final_commitment = 8.0
    state = CanonicalState(
        players_in_hand=2,
        hero_position=opener,
        opponent_position=three_bettor,
        street="flop",
        pot_size=(
            1.5
            - POSTED_BLIND_BB[opener]
            - POSTED_BLIND_BB[three_bettor]
            + 2 * final_commitment
        ),
        current_bet=0,
        preflop_action_history=[
            PreflopAction(actor=opener, action="raise", amount=2.5),
            PreflopAction(
                actor=three_bettor,
                action="raise",
                amount=final_commitment,
            ),
            PreflopAction(
                actor=opener,
                action="call",
                amount=final_commitment,
            ),
        ],
    )

    assert select(state).source == "preflop_chart_three_bet_pot"


def test_selects_chart_ranges_for_heads_up_cold_three_bet_pot() -> None:
    selection = select(cold_three_bet_pot_state())

    assert selection.source == "preflop_chart_cold_three_bet_pot"
    assert selection.context == {
        "scenario": "cold_three_bet_pot",
        "folded_opener_position": "utg",
        "folded_opener_commitment_bb": 2.5,
        "three_bettor_position": "cutoff",
        "cold_caller_position": "button",
        "opening_size_bb": 2.5,
        "three_bet_size_bb": 8.0,
        "open_size_policy": "standard",
        "three_bet_size_policy": "standard",
        "stack_depth_policy": "standard",
        "starting_effective_stack_bb": 100.0,
        "stack_depth_source": "reconstructed",
        "three_bettor_base_fraction": 0.05,
        "three_bettor_fraction": 0.05,
        "cold_caller_base_continue_fraction": 0.05,
        "cold_caller_base_four_bet_fraction": 0.02,
        "cold_caller_continue_fraction": 0.05,
        "cold_caller_four_bet_fraction": 0.02,
        "cold_three_bet_policy": "conservative_three_player",
    }
    assert "AA" in selection.oop_range.split(",")
    assert "AA" not in selection.ip_range.split(",")
    assert selection.ip_range != DEFAULT_POSTFLOP_IP_RANGE
    assert selection.oop_range != DEFAULT_POSTFLOP_OOP_RANGE


def test_assigns_cold_three_bet_ranges_by_relative_position() -> None:
    caller_hero = select(cold_three_bet_pot_state(hero_position="button"))
    three_bettor_hero = select_postflop_ranges(
        cold_three_bet_pot_state(hero_position="cutoff"),
        hero_relative_position="oop",
        configured_oop_range=DEFAULT_POSTFLOP_OOP_RANGE,
        configured_ip_range=DEFAULT_POSTFLOP_IP_RANGE,
        contextual_enabled=True,
    )

    assert caller_hero.ip_range == three_bettor_hero.ip_range
    assert caller_hero.oop_range == three_bettor_hero.oop_range


@pytest.mark.parametrize(
    ("folded_opener", "three_bettor", "cold_caller"),
    sorted(COLD_THREE_BET_DEFENSE_POLICIES),
)
def test_supports_every_charted_cold_three_bet_matchup(
    folded_opener: Position,
    three_bettor: Position,
    cold_caller: Position,
) -> None:
    opening_size = 2.5
    final_commitment = 8.0
    state = CanonicalState(
        players_in_hand=2,
        hero_position=cold_caller,
        opponent_position=three_bettor,
        street="flop",
        pot_size=(
            1.5
            + opening_size
            - POSTED_BLIND_BB[folded_opener]
            + final_commitment
            - POSTED_BLIND_BB[three_bettor]
            + final_commitment
            - POSTED_BLIND_BB[cold_caller]
        ),
        current_bet=0,
        preflop_action_history=[
            PreflopAction(
                actor=folded_opener,
                action="raise",
                amount=opening_size,
            ),
            PreflopAction(
                actor=three_bettor,
                action="raise",
                amount=final_commitment,
            ),
            PreflopAction(
                actor=cold_caller,
                action="call",
                amount=final_commitment,
            ),
        ],
    )

    assert select(state).source == "preflop_chart_cold_three_bet_pot"


def test_selects_cold_three_bet_ranges_on_turn_after_completed_flop() -> None:
    state = cold_three_bet_pot_state()
    state.street = "turn"
    state.completed_postflop_streets = [
        CompletedPostflopStreetHistory(
            street="flop",
            actions=[
                CompletedPostflopAction(actor="oop", action="check"),
                CompletedPostflopAction(actor="ip", action="check"),
            ],
        )
    ]

    selection = select(state)

    assert selection.source == "preflop_chart_cold_three_bet_pot"
    assert selection.context["decision_street"] == "turn"
    assert selection.context["completed_street_count"] == 1.0


def test_keeps_configured_ranges_for_contradictory_cold_three_bet_history() -> None:
    state = cold_three_bet_pot_state()
    state.players_in_hand = 3
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.opponent_position = "utg"
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.preflop_action_history[2].amount = 7.5
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.preflop_action_history[2].actor = "cutoff"
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.preflop_action_history[0].actor = "button"
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.preflop_action_history[1].amount = 13.0
    state.preflop_action_history[2].amount = 13.0
    state.pot_size = 30.0
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.pot_size = 17.5
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.preflop_opener_position = "hijack"
    assert select(state).source == "configured"

    state = cold_three_bet_pot_state()
    state.preflop_open_size = 3.0
    assert select(state).source == "configured"


def test_selects_chart_ranges_for_heads_up_four_bet_pot() -> None:
    selection = select(four_bet_pot_state())

    assert selection.source == "preflop_chart_four_bet_pot"
    assert selection.context == {
        "scenario": "four_bet_pot",
        "opener_position": "button",
        "three_bettor_position": "big_blind",
        "opening_size_bb": 2.5,
        "three_bet_size_bb": 8.0,
        "four_bet_size_bb": 20.0,
        "three_bet_size_policy": "standard",
        "four_bet_size_policy": "standard",
        "stack_depth_policy": "standard",
        "starting_effective_stack_bb": 100.0,
        "stack_depth_source": "reconstructed",
        "opener_base_four_bet_fraction": 0.065,
        "opener_four_bet_fraction": 0.065,
        "three_bettor_base_continue_fraction": 0.07,
        "three_bettor_base_five_bet_fraction": 0.038,
        "three_bettor_continue_fraction": 0.07,
        "three_bettor_five_bet_fraction": 0.038,
    }
    assert "AA" in selection.ip_range.split(",")
    assert "AA" not in selection.oop_range.split(",")
    assert selection.ip_range != DEFAULT_POSTFLOP_IP_RANGE
    assert selection.oop_range != DEFAULT_POSTFLOP_OOP_RANGE


def test_assigns_four_bet_ranges_by_relative_position() -> None:
    opener_hero = select(four_bet_pot_state(hero_position="button"))
    three_bettor_hero = select(
        four_bet_pot_state(hero_position="big_blind")
    )

    assert opener_hero.ip_range == three_bettor_hero.ip_range
    assert opener_hero.oop_range == three_bettor_hero.oop_range


@pytest.mark.parametrize(
    ("opener", "three_bettor"),
    sorted(FOUR_BET_DEFENSE_POLICIES),
)
def test_supports_every_charted_four_bet_matchup(
    opener: Position,
    three_bettor: Position,
) -> None:
    final_commitment = 20.0
    state = CanonicalState(
        players_in_hand=2,
        hero_position=opener,
        opponent_position=three_bettor,
        street="flop",
        pot_size=(
            1.5
            - POSTED_BLIND_BB[opener]
            - POSTED_BLIND_BB[three_bettor]
            + 2 * final_commitment
        ),
        current_bet=0,
        preflop_action_history=[
            PreflopAction(actor=opener, action="raise", amount=2.5),
            PreflopAction(actor=three_bettor, action="raise", amount=8.0),
            PreflopAction(
                actor=opener,
                action="raise",
                amount=final_commitment,
            ),
            PreflopAction(
                actor=three_bettor,
                action="call",
                amount=final_commitment,
            ),
        ],
    )

    assert select(state).source == "preflop_chart_four_bet_pot"


def test_keeps_configured_ranges_when_contextual_mode_is_disabled() -> None:
    selection = select(single_raised_pot_state(), contextual_enabled=False)

    assert selection.source == "configured"
    assert selection.context == {}
    assert selection.oop_range == DEFAULT_POSTFLOP_OOP_RANGE
    assert selection.ip_range == DEFAULT_POSTFLOP_IP_RANGE


def test_keeps_configured_ranges_for_incomplete_or_contradictory_history() -> None:
    state = single_raised_pot_state()
    state.preflop_action_history[1].amount = 3.0
    assert select(state).source == "configured"

    state = single_raised_pot_state()
    state.opponent_position = "cutoff"
    assert select(state).source == "configured"

    state = single_raised_pot_state()
    state.players_in_hand = 3
    assert select(state).source == "configured"

    state = single_raised_pot_state()
    state.preflop_open_size = 3.0
    assert select(state).source == "configured"

    state = single_raised_pot_state()
    state.pot_size = 15.0
    assert select(state).source == "configured"

    state = single_raised_pot_state()
    state.pot_size = None
    assert select(state).source == "configured"

    state = single_raised_pot_state()
    state.street = "turn"
    assert select(state).source == "configured"


def test_policy_band_excludes_the_reraise_segment() -> None:
    caller_classes = hand_classes_in_policy_band(0.4, minimum_exclusive=0.12)
    opener_classes = hand_classes_in_policy_band(0.45)

    assert caller_classes
    assert "AA" not in caller_classes
    assert "AA" in opener_classes


def test_open_size_adjusts_the_contextual_caller_band() -> None:
    small_open = single_raised_pot_state()
    small_open.preflop_action_history[0].amount = 2.0
    small_open.preflop_action_history[1].amount = 2.0
    small_open.pot_size = 4.5
    large_open = single_raised_pot_state()
    large_open.preflop_action_history[0].amount = 4.0
    large_open.preflop_action_history[1].amount = 4.0
    large_open.pot_size = 8.5

    small_selection = select(small_open)
    large_selection = select(large_open)

    assert small_selection.context["open_size_policy"] == "small"
    assert small_selection.context["caller_continue_fraction"] == 0.44
    assert small_selection.context["caller_reraise_fraction"] == 0.126
    assert large_selection.context["open_size_policy"] == "very_large"
    assert large_selection.context["caller_continue_fraction"] == 0.312
    assert large_selection.context["caller_reraise_fraction"] == 0.108
    assert len(small_selection.oop_range.split(",")) > len(
        large_selection.oop_range.split(",")
    )


def test_three_bet_size_adjusts_the_opener_call_band() -> None:
    small_three_bet = three_bet_pot_state()
    small_three_bet.preflop_action_history[1].amount = 6.5
    small_three_bet.preflop_action_history[2].amount = 6.5
    small_three_bet.pot_size = 13.5
    large_three_bet = three_bet_pot_state()
    large_three_bet.preflop_action_history[1].amount = 12.0
    large_three_bet.preflop_action_history[2].amount = 12.0
    large_three_bet.pot_size = 24.5

    small_selection = select(small_three_bet)
    large_selection = select(large_three_bet)

    assert small_selection.context["three_bet_size_policy"] == "small"
    assert small_selection.context["opener_continue_fraction"] == 0.189
    assert small_selection.context["opener_four_bet_fraction"] == 0.0683
    assert large_selection.context["three_bet_size_policy"] == "very_large"
    assert large_selection.context["opener_continue_fraction"] == 0.144
    assert large_selection.context["opener_four_bet_fraction"] == 0.0585
    assert len(small_selection.ip_range.split(",")) > len(
        large_selection.ip_range.split(",")
    )


def test_three_bet_size_adjusts_the_cold_caller_band() -> None:
    small_three_bet = cold_three_bet_pot_state()
    small_three_bet.preflop_action_history[1].amount = 6.5
    small_three_bet.preflop_action_history[2].amount = 6.5
    small_three_bet.pot_size = 17.0
    large_three_bet = cold_three_bet_pot_state()
    large_three_bet.preflop_action_history[1].amount = 12.0
    large_three_bet.preflop_action_history[2].amount = 12.0
    large_three_bet.pot_size = 28.0

    small_selection = select(small_three_bet)
    large_selection = select(large_three_bet)

    assert small_selection.context["three_bet_size_policy"] == "small"
    assert small_selection.context["cold_caller_continue_fraction"] == 0.0525
    assert small_selection.context["cold_caller_four_bet_fraction"] == 0.021
    assert large_selection.context["three_bet_size_policy"] == "very_large"
    assert large_selection.context["cold_caller_continue_fraction"] == 0.04
    assert large_selection.context["cold_caller_four_bet_fraction"] == 0.018
    assert len(small_selection.ip_range.split(",")) > len(
        large_selection.ip_range.split(",")
    )


def test_short_starting_stack_adjusts_single_raised_pot_ranges() -> None:
    state = single_raised_pot_state()
    state.effective_stack = 17.5

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "short"
    assert selection.context["starting_effective_stack_bb"] == 20.0
    assert selection.context["stack_depth_source"] == "reconstructed"
    assert selection.context["opener_base_fraction"] == 0.45
    assert selection.context["opener_fraction"] == 0.405
    assert selection.context["caller_continue_fraction"] == 0.36
    assert selection.context["caller_reraise_fraction"] == 0.156


def test_deep_starting_stack_adjusts_three_bet_pot_ranges() -> None:
    state = three_bet_pot_state()
    state.effective_stack = 192.0

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "deep"
    assert selection.context["starting_effective_stack_bb"] == 200.0
    assert selection.context["stack_depth_source"] == "reconstructed"
    assert selection.context["three_bettor_fraction"] == 0.108
    assert selection.context["opener_continue_fraction"] == 0.189
    assert selection.context["opener_four_bet_fraction"] == 0.0585


def test_medium_starting_stack_adjusts_four_bet_pot_ranges() -> None:
    state = four_bet_pot_state()
    state.effective_stack = 30.0

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "medium"
    assert selection.context["starting_effective_stack_bb"] == 50.0
    assert selection.context["stack_depth_source"] == "reconstructed"
    assert selection.context["opener_four_bet_fraction"] == 0.0747
    assert selection.context["three_bettor_continue_fraction"] == 0.0665
    assert selection.context["three_bettor_five_bet_fraction"] == 0.0437


def test_reconstructs_starting_stack_across_current_street_wagers() -> None:
    state = three_bet_pot_state()
    state.pot_size = 18.5
    state.current_bet = 2.0
    state.facing_action = "bet"
    state.hero_stack = 92.0
    state.opponent_stack = 90.0
    state.effective_stack = 90.0
    state.postflop_action_history = [
        PostflopAction(actor="oop", action="bet", amount=2.0)
    ]

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "standard"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"


def test_reconstructs_starting_stack_from_explicit_first_bet() -> None:
    state = three_bet_pot_state()
    state.pot_size = 18.5
    state.current_bet = 2.0
    state.facing_action = "bet"
    state.hero_stack = 92.0
    state.opponent_stack = 90.0
    state.effective_stack = 90.0

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "standard"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"


def test_reconstructs_starting_stack_across_current_street_reraises() -> None:
    state = three_bet_pot_state(hero_position="button")
    state.pot_size = 32.5
    state.current_bet = 4.0
    state.facing_action = "raise"
    state.hero_stack = 86.0
    state.opponent_stack = 82.0
    state.effective_stack = 82.0
    state.postflop_action_history = [
        PostflopAction(actor="oop", action="bet", amount=2.0),
        PostflopAction(actor="ip", action="raise", amount=6.0),
        PostflopAction(actor="oop", action="raise", amount=10.0),
    ]

    selection = select(state)

    assert selection.source == "preflop_chart_three_bet_pot"
    assert selection.context["stack_depth_policy"] == "standard"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "reconstructed"


def test_uses_standard_stack_assumption_when_reconstruction_is_incomplete() -> None:
    state = three_bet_pot_state()
    state.pot_size = 18.5
    state.current_bet = 2.0
    state.facing_action = "bet"
    state.hero_stack = 92.0
    state.opponent_stack = None
    state.effective_stack = 90.0
    state.postflop_action_history = [
        PostflopAction(actor="oop", action="bet", amount=2.0)
    ]

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "standard"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "standard_assumption"


def test_uses_standard_stack_assumption_for_contradictory_visible_stacks() -> None:
    state = single_raised_pot_state()
    state.hero_stack = 97.5
    state.opponent_stack = 95.0
    state.effective_stack = 94.0

    selection = select(state)

    assert selection.context["stack_depth_policy"] == "standard"
    assert selection.context["starting_effective_stack_bb"] == 100.0
    assert selection.context["stack_depth_source"] == "standard_assumption"


def test_keeps_configured_ranges_for_contradictory_three_bet_history() -> None:
    state = three_bet_pot_state()
    state.preflop_action_history[2].amount = 7.5
    assert select(state).source == "configured"

    state = three_bet_pot_state()
    state.pot_size = 30.0
    assert select(state).source == "configured"

    state = three_bet_pot_state()
    state.preflop_action_history[0].actor = "big_blind"
    state.preflop_action_history[2].actor = "big_blind"
    state.preflop_action_history[1].actor = "button"
    assert select(state).source == "configured"

    state = three_bet_pot_state()
    state.preflop_action_history[1].amount = 13.0
    state.preflop_action_history[2].amount = 13.0
    state.pot_size = 26.5
    assert select(state).source == "configured"

    state = three_bet_pot_state()
    state.players_in_hand = 3
    assert select(state).source == "configured"


def test_four_bet_size_adjusts_the_three_bettor_call_band() -> None:
    small_four_bet = four_bet_pot_state()
    small_four_bet.preflop_action_history[2].amount = 16.0
    small_four_bet.preflop_action_history[3].amount = 16.0
    small_four_bet.pot_size = 32.5
    large_four_bet = four_bet_pot_state()
    large_four_bet.preflop_action_history[2].amount = 26.0
    large_four_bet.preflop_action_history[3].amount = 26.0
    large_four_bet.pot_size = 52.5

    small_selection = select(small_four_bet)
    large_selection = select(large_four_bet)

    assert small_selection.context["four_bet_size_policy"] == "small"
    assert small_selection.context["three_bettor_continue_fraction"] == 0.0735
    assert small_selection.context["three_bettor_five_bet_fraction"] == 0.0399
    assert large_selection.context["four_bet_size_policy"] == "very_large"
    assert large_selection.context["three_bettor_continue_fraction"] == 0.056
    assert large_selection.context["three_bettor_five_bet_fraction"] == 0.0342
    assert len(small_selection.oop_range.split(",")) > len(
        large_selection.oop_range.split(",")
    )


def test_keeps_configured_ranges_for_contradictory_four_bet_history() -> None:
    state = four_bet_pot_state()
    state.preflop_action_history[3].amount = 19.0
    assert select(state).source == "configured"

    state = four_bet_pot_state()
    state.pot_size = 60.0
    assert select(state).source == "configured"

    state = four_bet_pot_state()
    state.preflop_action_history[2].actor = "big_blind"
    assert select(state).source == "configured"

    state = four_bet_pot_state()
    state.preflop_action_history[2].amount = 12.0
    state.preflop_action_history[3].amount = 12.0
    state.pot_size = 24.5
    assert select(state).source == "configured"

    state = four_bet_pot_state()
    state.preflop_action_history[2].amount = 29.0
    state.preflop_action_history[3].amount = 29.0
    state.pot_size = 58.5
    assert select(state).source == "configured"

    state = four_bet_pot_state()
    state.players_in_hand = 3
    assert select(state).source == "configured"


def test_reconstructs_flop_root_from_current_street_wagers() -> None:
    facing_bet = single_raised_pot_state()
    facing_bet.pot_size = 7.5
    facing_bet.current_bet = 2.0
    facing_bet.facing_action = "bet"
    assert select(facing_bet).source == "preflop_chart_single_raised_pot"

    facing_raise = single_raised_pot_state()
    facing_raise.pot_size = 14.5
    facing_raise.current_bet = 5.0
    facing_raise.facing_action = "raise"
    facing_raise.postflop_action_history = [
        PostflopAction(actor="oop", action="bet", amount=2.0),
        PostflopAction(actor="ip", action="raise", amount=7.0),
    ]
    assert select(facing_raise).source == "preflop_chart_single_raised_pot"

    three_bet_facing_bet = three_bet_pot_state()
    three_bet_facing_bet.pot_size = 18.5
    three_bet_facing_bet.current_bet = 2.0
    three_bet_facing_bet.facing_action = "bet"
    assert select(three_bet_facing_bet).source == (
        "preflop_chart_three_bet_pot"
    )

    cold_three_bet_facing_bet = cold_three_bet_pot_state()
    cold_three_bet_facing_bet.pot_size = 22.0
    cold_three_bet_facing_bet.current_bet = 2.0
    cold_three_bet_facing_bet.facing_action = "bet"
    assert select(cold_three_bet_facing_bet).source == (
        "preflop_chart_cold_three_bet_pot"
    )

    four_bet_facing_bet = four_bet_pot_state()
    four_bet_facing_bet.pot_size = 42.5
    four_bet_facing_bet.current_bet = 2.0
    four_bet_facing_bet.facing_action = "bet"
    assert select(four_bet_facing_bet).source == (
        "preflop_chart_four_bet_pot"
    )
