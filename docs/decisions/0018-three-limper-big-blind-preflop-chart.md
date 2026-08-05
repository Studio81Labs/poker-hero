# ADR 0018: Add a Three-Limper Big-Blind Response

Status: accepted

## Context

The structured preflop chart can respond to one or two limpers when action
reaches hero's big-blind option. A third limper is equally reconstructible from
three exact calls, four active players, and the blind-only pot, but currently
falls back. Reusing the two-limper policy would overstate the isolation range
in a still wider multiway field.

## Decision

Route exactly three ordered 1 BB calls before hero in the big blind only when
exactly four players remain active. Require distinct limper seats in legal
six-max action order, no facing aggression or legacy opener metadata, and a pot
reconstructed from blinds plus all three commitments.

Use an explicit raise policy for every legal three-limper seat triple. Keep each
range tighter than every corresponding two-limper pair and apply the existing
stack-depth adjustment. Target the larger of 6 BB or 1.5x the pot, capped by
the effective total represented by hero's posted big blind and effective stack.
Reuse the multi-limper evidence contract to record all three seats, count,
named policy, base and adjusted range, target, and cap.

Decline routing for a hidden active player, a fourth limp, duplicate or
out-of-order seats, non-call actions, non-1 BB totals, a non-big-blind hero, or
contradictory pot state. These states retain the configured range/EV fallback.

## Consequences

- A common three-limper big-blind option receives deterministic, inspectable
  training guidance.
- The triple-specific policies remain visibly distinct from heads-up and
  two-limper ranges.
- This decision originally left four or more limpers, action after hero, and
  arbitrary limp trees outside the bundled chart.

ADR 0019 extends the same strict boundary to exactly four limpers. Five or more
limpers and arbitrary limp trees remain outside the bundled chart.
