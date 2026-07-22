# ADR 0002: Add A Position-Aware Preflop Training Chart

Status: accepted

## Context

The bundled range/EV fallback evaluates preflop equity but has no positional
opening or defense policy. That can produce semantically weak advice, including
postflop-shaped actions in unopened preflop spots. The canonical state also
lacks opener position and complete action history, so it cannot support a
general preflop tree solve without inventing inputs.

## Decision

Route preflop states with two hero cards, a recognized six-max position, and an
unambiguous first-in or single-open-raise context to a local training chart. The
chart orders all 169 starting-hand classes with explicit playability
adjustments, then applies conservative position-specific opening boundaries and
opener-to-hero matchup boundaries for continuing and reraising. It returns the
normalized hand class, positions, scenario, modeled opening range, response
boundaries, assumptions, and candidate frequencies as recommendation evidence.

The chart declines limped pots, 3-bet or later action, missing positions, and
unopened pots whose size suggests missing action. Those states continue to the
existing range/EV fallback. Explanations must call this a transparent training
chart, not a solved preflop game tree. Supported chart routing is independent
of the postflop solver's fallback switch because it is a first-class local
engine route, not a recovery from a failed postflop solve. Facing-raise charts
also require a plausible single-open call amount and approved action text that
identifies an opener position acting before hero. Explicitly selecting the
`local_ev` engine bypasses chart routing and preserves the configured provider
contract.

## Consequences

- Supported preflop recommendations use legal preflop actions and account for
  hero and opener position.
- Ambiguous screenshots remain reviewable and retain a functional fallback.
- The policy is deterministic, testable, and replaceable behind the existing
  provider boundary.
- Accurate limper, 3-bet, ante, and tournament modeling still
  requires richer canonical action history or a licensed preflop solver.

ADR 0003 later adds structured opener position and opening size to the canonical
state while preserving this chart's conservative text fallback. Those structured
fields also make matchup-specific defense deterministic after manual review.
