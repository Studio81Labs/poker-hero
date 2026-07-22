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
opener-to-hero matchup boundaries for continuing and reraising. Supported 2-4
BB total opens apply ordered size bands: smaller opens widen the response ranges,
while larger opens tighten them. Effective stack applies short (up to 20 BB),
medium (up to 50 BB), standard (up to 150 BB), and deep bands. Shorter bands
trim speculative first-in and calling ranges, reduce first-in sizing, and move
more continues into reraises; deep stacks modestly widen calls and reduce the
reraise share. It returns the normalized hand class, positions, scenario, base
and stack-adjusted modeled opening ranges, base and adjusted response
boundaries, size and stack policies, assumptions, and candidate frequencies as
recommendation evidence.

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
- Parsed, structured, and reconstructed opening sizes share one consistency
  check, so contradictory call amounts decline chart routing.
- Stack-depth adjustments are deterministic heuristics with explicit evidence;
  they are not represented as solved frequencies.
- Accurate limper, 3-bet, ante, and tournament modeling still
  requires richer canonical action history or a licensed preflop solver.

ADR 0003 later adds structured opener position and opening size to the canonical
state while preserving this chart's conservative text fallback. Those structured
fields also make matchup-specific defense deterministic after manual review.
