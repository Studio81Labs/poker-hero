from __future__ import annotations

from app.models import CanonicalState
from app.solvers.preflop_context import opening_raise_size


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

    if state.street == "preflop":
        if (
            state.preflop_open_size is not None
            and state.preflop_open_size >= amount_to_call
        ):
            return state.preflop_open_size
        context_size = opening_raise_size(state.action_context)
        if context_size is not None and context_size >= amount_to_call:
            return context_size

    if state.facing_action == "bet":
        return amount_to_call
    return None
