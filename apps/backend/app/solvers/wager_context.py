from __future__ import annotations

from app.models import CanonicalState
from app.solvers.preflop_context import (
    MONEY_TOLERANCE_BB,
    POSTED_BLIND_BB,
    normalize_position,
    opening_raise_size,
)


def resolve_opponent_wager(state: CanonicalState) -> float | None:
    """Resolve the total current-street wager already represented in the pot."""
    amount_to_call = state.current_bet or 0
    if amount_to_call <= 0:
        return 0.0
    if state.opponent_wager is not None:
        return state.opponent_wager

    history = (
        state.preflop_action_history
        if state.street == "preflop"
        else state.postflop_action_history
    )
    history_amounts = [
        action.amount
        for action in history
        if action.amount is not None and action.amount >= amount_to_call
    ]
    if history_amounts:
        return max(history_amounts)

    if state.street == "preflop" and state.facing_action == "raise":
        hero_position = normalize_position(state.hero_position)
        opening_wager = state.preflop_open_size
        if opening_wager is None:
            opening_wager = opening_raise_size(state.action_context)
        if hero_position is not None and opening_wager is not None:
            expected_opening_wager = (
                amount_to_call + POSTED_BLIND_BB[hero_position]
            )
            if (
                abs(opening_wager - expected_opening_wager)
                <= MONEY_TOLERANCE_BB
            ):
                return opening_wager

    if state.street != "preflop" and state.facing_action == "bet":
        return amount_to_call
    return None
