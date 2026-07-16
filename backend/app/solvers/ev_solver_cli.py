from __future__ import annotations

import hashlib
import random
import sys
from dataclasses import dataclass
from itertools import combinations
from math import comb
from typing import Iterable

from pydantic import ValidationError

from app.models import Card, RecommendationAction, RecommendationRequest, RecommendationResult
from app.providers.rule_based import (
    DECK_CODES,
    HAND_CATEGORY_LABELS,
    PostflopAnalysis,
    _best_hand_score,
    _draw_raw,
    _postflop_analysis,
    _pot_odds,
    _score_key,
    _starting_hand_score,
)

MAX_EXACT_CASES = 140_000


@dataclass(frozen=True)
class WeightedCombo:
    cards: tuple[Card, Card]
    weight: float
    score: float


@dataclass(frozen=True)
class EquityEstimate:
    equity: float
    win_rate: float
    tie_rate: float
    iterations: int
    opponents: int
    method: str
    opponent_combos: int
    range_fraction: float


@dataclass(frozen=True)
class Candidate:
    action: RecommendationAction
    sizing: float | None
    ev: float
    fold_equity: float | None = None
    called_equity: float | None = None


def recommend(raw_request: str) -> RecommendationResult:
    request = RecommendationRequest.model_validate_json(raw_request)
    return solve(request)


def solve(request: RecommendationRequest) -> RecommendationResult:
    state = request.state
    hero_cards = state.hero_cards
    board_cards = state.board_cards
    street = state.street or "preflop"
    pot_size = state.pot_size or 0
    current_bet = state.current_bet or 0
    players = max(2, min(state.players_in_hand or 2, 6))
    effective_stack = max(0.0, state.effective_stack or max(20.0, pot_size * 8))
    facing_bet = current_bet > 0

    analysis = _postflop_analysis(hero_cards, board_cards) if street != "preflop" else None
    equity = _estimate_range_equity(
        hero_cards=hero_cards,
        board_cards=board_cards,
        players_in_hand=players,
        street=street,
        facing_bet=facing_bet,
    )
    realized_equity = _realized_equity(equity.equity, hero_cards, analysis, players, facing_bet, street)
    required_equity = _pot_odds(current_bet, pot_size) if facing_bet else None

    candidates = _action_candidates(
        pot_size=pot_size,
        current_bet=current_bet,
        effective_stack=effective_stack,
        players=players,
        street=street,
        facing_bet=facing_bet,
        realized_equity=realized_equity,
        analysis=analysis,
        hero_cards=hero_cards,
    )
    best = max(candidates, key=lambda candidate: (candidate.ev, _action_rank(candidate.action)))
    second_best = sorted(candidates, key=lambda candidate: candidate.ev, reverse=True)[1] if len(candidates) > 1 else best
    confidence = _confidence(best, second_best, pot_size, equity.method)

    return RecommendationResult(
        action=best.action,
        sizing=best.sizing,
        confidence=confidence,
        explanation=_explanation(best, equity, realized_equity, required_equity, analysis, street, facing_bet),
        raw={
            "provider": "local_solver",
            "engine": "local_ev_solver_v1",
            "stage": street,
            "equity": _equity_raw(equity),
            "realized_equity": realized_equity,
            "required_equity": required_equity,
            "hand_category": _hand_category_label(analysis),
            "draws": _draw_raw(analysis.draws) if analysis is not None else None,
            "wet_board": analysis.wet_board if analysis is not None else None,
            "candidates": [_candidate_raw(candidate) for candidate in candidates],
            "process_boundary": "stdin_stdout_json",
        },
    )


def _estimate_range_equity(
    *,
    hero_cards: list[Card],
    board_cards: list[Card],
    players_in_hand: int,
    street: str,
    facing_bet: bool,
) -> EquityEstimate:
    opponents = max(1, min(players_in_hand - 1, 5))
    known_codes = {card.code for card in [*hero_cards, *board_cards]}
    deck = [Card.from_code(code) for code in DECK_CODES if code not in known_codes]
    board_needed = max(0, 5 - len(board_cards))
    if len(hero_cards) < 2 or board_needed + opponents * 2 > len(deck):
        return EquityEstimate(0, 0, 0, 0, opponents, "unavailable", 0, 0)

    combos, range_fraction = _opponent_range(deck, board_cards, street, facing_bet, players_in_hand)
    if not combos:
        combos = [WeightedCombo(tuple(combo), 1.0, 0.0) for combo in combinations(deck, 2)]
        range_fraction = 1.0

    exact_cases = len(combos) * (comb(max(0, len(deck) - 2), board_needed) if board_needed else 1)
    if opponents == 1 and exact_cases <= MAX_EXACT_CASES:
        return _exact_single_opponent_equity(hero_cards, board_cards, deck, combos, board_needed, range_fraction)

    return _monte_carlo_equity(
        hero_cards=hero_cards,
        board_cards=board_cards,
        deck=deck,
        combos=combos,
        board_needed=board_needed,
        opponents=opponents,
        street=street,
        facing_bet=facing_bet,
        players_in_hand=players_in_hand,
        range_fraction=range_fraction,
    )


def _opponent_range(
    deck: list[Card],
    board_cards: list[Card],
    street: str,
    facing_bet: bool,
    players_in_hand: int,
) -> tuple[list[WeightedCombo], float]:
    all_combos = [tuple(combo) for combo in combinations(deck, 2)]
    scored = [
        WeightedCombo(cards=cast_combo(combo), weight=1.0, score=_opponent_combo_score(combo, board_cards, street))
        for combo in all_combos
    ]
    scored.sort(key=lambda combo: combo.score, reverse=True)
    fraction = _range_fraction(street, facing_bet, players_in_hand)
    keep_count = max(40, min(len(scored), round(len(scored) * fraction)))
    kept = scored[:keep_count]
    max_score = max((combo.score for combo in kept), default=1.0)
    weighted = [
        WeightedCombo(
            cards=combo.cards,
            score=combo.score,
            weight=max(0.08, (combo.score / max_score) ** 1.45),
        )
        for combo in kept
    ]
    return weighted, round(keep_count / len(scored), 3) if scored else 0


def cast_combo(combo: Iterable[Card]) -> tuple[Card, Card]:
    first, second = tuple(combo)
    return first, second


def _range_fraction(street: str, facing_bet: bool, players_in_hand: int) -> float:
    multiway_tighten = max(0, players_in_hand - 2) * 0.04
    if street == "preflop":
        return max(0.18, (0.36 if facing_bet else 0.68) - multiway_tighten)
    if street == "river":
        return max(0.22, (0.42 if facing_bet else 0.72) - multiway_tighten)
    if street == "turn":
        return max(0.24, (0.46 if facing_bet else 0.76) - multiway_tighten)
    return max(0.26, (0.52 if facing_bet else 0.82) - multiway_tighten)


def _opponent_combo_score(combo: tuple[Card, Card], board_cards: list[Card], street: str) -> float:
    if street == "preflop" or not board_cards:
        return _starting_hand_score(list(combo))

    analysis = _postflop_analysis(list(combo), board_cards)
    score = analysis.made_hand.category * 30
    score += max(analysis.made_hand.tiebreakers, default=0) * 1.2
    if analysis.top_pair_or_better:
        score += 18
    if analysis.overpair:
        score += 16
    if analysis.draws.flush_draw:
        score += 10
    if analysis.draws.open_ended_straight_draw:
        score += 8
    if analysis.draws.gutshot_straight_draw:
        score += 4
    score += analysis.draws.overcards * 2
    return score


def _exact_single_opponent_equity(
    hero_cards: list[Card],
    board_cards: list[Card],
    deck: list[Card],
    combos: list[WeightedCombo],
    board_needed: int,
    range_fraction: float,
) -> EquityEstimate:
    equity_total = 0.0
    weighted_cases = 0.0
    win_weight = 0.0
    tie_weight = 0.0
    iterations = 0

    for combo in combos:
        used = {card.code for card in combo.cards}
        runout_deck = [card for card in deck if card.code not in used]
        runouts = combinations(runout_deck, board_needed) if board_needed else [()]
        for runout in runouts:
            final_board = [*board_cards, *runout]
            outcome = _hero_outcome(hero_cards, [list(combo.cards)], final_board)
            weighted_cases += combo.weight
            equity_total += combo.weight * outcome
            if outcome == 1:
                win_weight += combo.weight
            elif outcome > 0:
                tie_weight += combo.weight
            iterations += 1

    if weighted_cases == 0:
        return EquityEstimate(0, 0, 0, 0, 1, "exact_single_opponent", len(combos), range_fraction)

    return EquityEstimate(
        equity=round(equity_total / weighted_cases, 3),
        win_rate=round(win_weight / weighted_cases, 3),
        tie_rate=round(tie_weight / weighted_cases, 3),
        iterations=iterations,
        opponents=1,
        method="exact_single_opponent",
        opponent_combos=len(combos),
        range_fraction=range_fraction,
    )


def _monte_carlo_equity(
    *,
    hero_cards: list[Card],
    board_cards: list[Card],
    deck: list[Card],
    combos: list[WeightedCombo],
    board_needed: int,
    opponents: int,
    street: str,
    facing_bet: bool,
    players_in_hand: int,
    range_fraction: float,
) -> EquityEstimate:
    iterations = _sample_budget(street, opponents)
    rng = random.Random(_seed(hero_cards, board_cards, players_in_hand, street, facing_bet))
    equity_total = 0.0
    wins = 0
    ties = 0
    completed = 0

    for _ in range(iterations):
        used = {card.code for card in [*hero_cards, *board_cards]}
        opponent_hands: list[list[Card]] = []
        for _opponent_index in range(opponents):
            combo = _weighted_choice_available(combos, used, rng)
            if combo is None:
                available = [card for card in deck if card.code not in used]
                if len(available) < 2:
                    break
                chosen = rng.sample(available, 2)
            else:
                chosen = list(combo.cards)
            opponent_hands.append(chosen)
            used.update(card.code for card in chosen)

        if len(opponent_hands) != opponents:
            continue

        board_deck = [card for card in deck if card.code not in used]
        if len(board_deck) < board_needed:
            continue
        final_board = [*board_cards, *rng.sample(board_deck, board_needed)]
        outcome = _hero_outcome(hero_cards, opponent_hands, final_board)
        equity_total += outcome
        if outcome == 1:
            wins += 1
        elif outcome > 0:
            ties += 1
        completed += 1

    if completed == 0:
        return EquityEstimate(0, 0, 0, 0, opponents, "monte_carlo_range", len(combos), range_fraction)

    return EquityEstimate(
        equity=round(equity_total / completed, 3),
        win_rate=round(wins / completed, 3),
        tie_rate=round(ties / completed, 3),
        iterations=completed,
        opponents=opponents,
        method="monte_carlo_range",
        opponent_combos=len(combos),
        range_fraction=range_fraction,
    )


def _sample_budget(street: str, opponents: int) -> int:
    if street == "preflop":
        base = 3600
    elif street == "flop":
        base = 3400
    elif street == "turn":
        base = 3000
    else:
        base = 2400
    return max(1600, round(base * max(0.62, 1 - (opponents - 1) * 0.1)))


def _weighted_choice_available(
    combos: list[WeightedCombo], used_codes: set[str], rng: random.Random
) -> WeightedCombo | None:
    available = [combo for combo in combos if all(card.code not in used_codes for card in combo.cards)]
    total = sum(combo.weight for combo in available)
    if total <= 0:
        return None
    target = rng.random() * total
    cursor = 0.0
    for combo in available:
        cursor += combo.weight
        if cursor >= target:
            return combo
    return available[-1] if available else None


def _hero_outcome(hero_cards: list[Card], opponent_hands: list[list[Card]], final_board: list[Card]) -> float:
    hero_score = _score_key(_best_hand_score([*hero_cards, *final_board]))
    opponent_scores = [_score_key(_best_hand_score([*hand, *final_board])) for hand in opponent_hands]
    best_score = max([hero_score, *opponent_scores])
    if hero_score != best_score:
        return 0.0
    winner_count = 1 + sum(1 for score in opponent_scores if score == best_score)
    return 1 / winner_count


def _realized_equity(
    equity: float,
    hero_cards: list[Card],
    analysis: PostflopAnalysis | None,
    players: int,
    facing_bet: bool,
    street: str,
) -> float:
    if street == "preflop":
        hand_score = _starting_hand_score(hero_cards)
        if hand_score >= 82:
            factor = 0.96
        elif hand_score >= 68:
            factor = 0.9
        elif hand_score >= 54:
            factor = 0.82
        elif hand_score >= 42:
            factor = 0.72
        else:
            factor = 0.62
        if len(hero_cards) == 2 and hero_cards[0].suit == hero_cards[1].suit:
            factor += 0.04
        if facing_bet:
            factor -= 0.04
    else:
        factor = 0.94
        if analysis is not None:
            if analysis.made_hand.category >= 2:
                factor += 0.05
            elif analysis.top_pair_or_better or analysis.overpair:
                factor += 0.02
            elif analysis.draws.has_strong_draw:
                factor += 0.03
            elif analysis.made_hand.category == 0:
                factor -= 0.08
        if facing_bet:
            factor -= 0.03

    factor -= max(0, players - 2) * 0.04
    return round(equity * min(1.0, max(0.52, factor)), 3)


def _action_candidates(
    *,
    pot_size: float,
    current_bet: float,
    effective_stack: float,
    players: int,
    street: str,
    facing_bet: bool,
    realized_equity: float,
    analysis: PostflopAnalysis | None,
    hero_cards: list[Card],
) -> list[Candidate]:
    if facing_bet:
        candidates = [
            Candidate("fold", None, 0.0),
            Candidate("call", None, round(realized_equity * (pot_size + current_bet) - current_bet, 3)),
        ]
        for raise_size in _raise_sizes(current_bet, pot_size, effective_stack):
            fold_equity = _fold_equity(raise_size, pot_size, players, street, facing_bet, analysis)
            called_equity = _called_equity(realized_equity, raise_size, pot_size, analysis)
            called_pot = pot_size + 2 * raise_size
            ev = fold_equity * pot_size + (1 - fold_equity) * (called_equity * called_pot - raise_size)
            candidates.append(Candidate("raise", raise_size, round(ev, 3), fold_equity, called_equity))
        return candidates

    candidates = [Candidate("check", None, round(realized_equity * pot_size, 3))]
    for bet_size in _bet_sizes(pot_size, effective_stack, street, hero_cards):
        fold_equity = _fold_equity(bet_size, pot_size, players, street, facing_bet, analysis)
        called_equity = _called_equity(realized_equity, bet_size, pot_size, analysis)
        called_pot = pot_size + 2 * bet_size
        ev = fold_equity * pot_size + (1 - fold_equity) * (called_equity * called_pot - bet_size)
        candidates.append(Candidate("bet", bet_size, round(ev, 3), fold_equity, called_equity))
    return candidates


def _bet_sizes(pot_size: float, effective_stack: float, street: str, hero_cards: list[Card]) -> list[float]:
    if street == "preflop":
        sizes = [max(2.5, pot_size * 0.65), max(3.0, pot_size * 0.9)]
    else:
        sizes = [max(1.0, pot_size * fraction) for fraction in (0.5, 0.7, 1.0)]
    return _unique_sizes(min(size, effective_stack) for size in sizes if size > 0)


def _raise_sizes(current_bet: float, pot_size: float, effective_stack: float) -> list[float]:
    sizes = [
        max(current_bet * 2.7, pot_size * 0.65),
        max(current_bet * 3.4, pot_size * 0.9),
    ]
    return _unique_sizes(min(size, effective_stack) for size in sizes if size > current_bet)


def _unique_sizes(sizes: Iterable[float]) -> list[float]:
    unique = sorted({round(size, 2) for size in sizes if size > 0})
    return unique[:3]


def _fold_equity(
    size: float,
    pot_size: float,
    players: int,
    street: str,
    facing_bet: bool,
    analysis: PostflopAnalysis | None,
) -> float:
    fraction = size / pot_size if pot_size > 0 else 1.0
    base = 0.22 + min(0.22, fraction * 0.16)
    base -= max(0, players - 2) * 0.08
    if facing_bet:
        base -= 0.08
    if street == "river":
        base += 0.04
    if analysis is not None:
        if analysis.wet_board:
            base -= 0.04
        if analysis.made_hand.category >= 2 or analysis.overpair:
            base -= 0.04
        elif analysis.draws.has_strong_draw:
            base += 0.02
    return round(min(0.58, max(0.04, base)), 3)


def _called_equity(
    realized_equity: float, size: float, pot_size: float, analysis: PostflopAnalysis | None
) -> float:
    fraction = size / pot_size if pot_size > 0 else 1.0
    penalty = 0.04 + min(0.08, fraction * 0.05)
    if analysis is not None:
        if analysis.made_hand.category >= 3:
            penalty -= 0.05
        elif analysis.made_hand.category >= 2 or analysis.overpair:
            penalty -= 0.03
        elif analysis.draws.has_strong_draw:
            penalty -= 0.01
    return round(min(0.98, max(0.02, realized_equity - penalty)), 3)


def _confidence(best: Candidate, second_best: Candidate, pot_size: float, method: str) -> float:
    ev_gap = max(0.0, best.ev - second_best.ev)
    denominator = max(1.0, pot_size)
    base = 0.56 + min(0.26, ev_gap / denominator)
    if method.startswith("exact"):
        base += 0.04
    return round(min(0.86, max(0.5, base)), 2)


def _explanation(
    best: Candidate,
    equity: EquityEstimate,
    realized_equity: float,
    required_equity: float | None,
    analysis: PostflopAnalysis | None,
    street: str,
    facing_bet: bool,
) -> str:
    label = _hand_category_label(analysis)
    if facing_bet and required_equity is not None:
        context = (
            f"Range equity is {equity.equity:.1%} ({realized_equity:.1%} realized) "
            f"against a weighted opponent range; the call price needs {required_equity:.1%}."
        )
    else:
        context = (
            f"Range equity is {equity.equity:.1%} ({realized_equity:.1%} realized) "
            "against a weighted opponent range."
        )
    size_text = f" {best.sizing:g} BB" if best.sizing is not None else ""
    hand_text = f" with {label}" if label else ""
    return (
        f"Local EV solver compared candidate actions and chose {best.action}{size_text}{hand_text}. "
        f"{context} This is a local range/EV estimate, not a full GTO tree solve."
    )


def _hand_category_label(analysis: PostflopAnalysis | None) -> str | None:
    if analysis is None:
        return None
    return HAND_CATEGORY_LABELS[analysis.made_hand.category]


def _equity_raw(equity: EquityEstimate) -> dict[str, object]:
    return {
        "equity": equity.equity,
        "win_rate": equity.win_rate,
        "tie_rate": equity.tie_rate,
        "iterations": equity.iterations,
        "opponents": equity.opponents,
        "method": equity.method,
        "opponent_combos": equity.opponent_combos,
        "range_fraction": equity.range_fraction,
    }


def _candidate_raw(candidate: Candidate) -> dict[str, object]:
    return {
        "action": candidate.action,
        "sizing": candidate.sizing,
        "ev": candidate.ev,
        "fold_equity": candidate.fold_equity,
        "called_equity": candidate.called_equity,
    }


def _action_rank(action: RecommendationAction) -> int:
    return {"fold": 0, "check": 1, "call": 2, "bet": 3, "raise": 4}[action]


def _seed(
    hero_cards: list[Card],
    board_cards: list[Card],
    players_in_hand: int,
    street: str,
    facing_bet: bool,
) -> int:
    seed_text = "|".join(
        [
            ",".join(sorted(card.code for card in hero_cards)),
            ",".join(sorted(card.code for card in board_cards)),
            str(players_in_hand),
            street,
            str(facing_bet),
            "local_ev_solver_v1",
        ]
    )
    return int.from_bytes(hashlib.sha256(seed_text.encode("utf-8")).digest()[:8], "big")


def main() -> int:
    try:
        result = recommend(sys.stdin.read())
    except ValidationError as exc:
        print(f"Invalid solver request: {exc}", file=sys.stderr)
        return 2

    print(result.model_dump_json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
