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


def resolve_opponent_commitment_total(
    state: CanonicalState,
    *,
    opponent_wager: float,
    opponents_at_current_bet: int,
) -> float:
    """Resolve active opponents' aggregate current-street commitments."""
    if (state.current_bet or 0) <= 0:
        return 0.0
    opponents = max(1, min((state.players_in_hand or 2) - 1, 5))
    if state.street == "preflop" and state.preflop_action_history:
        commitments: dict[str, float] = {}
        for action in state.preflop_action_history:
            commitments[action.actor] = max(
                commitments.get(action.actor, 0.0), action.amount
            )

        hero_position = normalize_position(state.hero_position)
        history_identifies_active_opponents = False
        if hero_position is not None:
            commitments.pop(hero_position, None)
            history_identifies_active_opponents = len(commitments) == opponents
        elif len(commitments) == opponents + 1:
            hero_wager = max(0.0, opponent_wager - (state.current_bet or 0))
            hero_matches = [
                actor
                for actor, amount in commitments.items()
                if abs(amount - hero_wager) <= MONEY_TOLERANCE_BB
            ]
            if len(hero_matches) == 1:
                commitments.pop(hero_matches[0])
                history_identifies_active_opponents = len(commitments) == opponents
        elif (
            abs(opponent_wager - (state.current_bet or 0))
            <= MONEY_TOLERANCE_BB
            and len(commitments) == opponents
        ):
            history_identifies_active_opponents = True

        opponents_at_latest_wager = sum(
            abs(amount - opponent_wager) <= MONEY_TOLERANCE_BB
            for amount in commitments.values()
        )
        if (
            history_identifies_active_opponents
            and opponents_at_latest_wager == opponents_at_current_bet
        ):
            return sum(commitments.values())

    return opponent_wager * opponents_at_current_bet
