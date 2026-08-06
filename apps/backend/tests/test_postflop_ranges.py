from __future__ import annotations

from app.config import DEFAULT_POSTFLOP_IP_RANGE, DEFAULT_POSTFLOP_OOP_RANGE
from app.models import CanonicalState, PostflopAction, PreflopAction
from app.solvers.postflop_ranges import select_postflop_ranges
from app.solvers.preflop_chart import hand_classes_in_policy_band


def single_raised_pot_state(*, hero_position: str = "big_blind") -> CanonicalState:
    opponent_position = "button" if hero_position == "big_blind" else "big_blind"
    return CanonicalState(
        players_in_hand=2,
        hero_position=hero_position,
        opponent_position=opponent_position,
        street="flop",
        pot_size=5.5,
        current_bet=0,
        preflop_action_history=[
            PreflopAction(actor="button", action="raise", amount=2.5),
            PreflopAction(actor="big_blind", action="call", amount=2.5),
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
