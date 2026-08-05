# ADR 0012: Add a Bounded Heads-Up Limp Response

Status: accepted

## Context

The structured preflop chart declines every limped pot even when the action is
fully represented and hero has the closing big-blind option. Sending this common
training spot to the generic range/EV fallback produces less useful preflop
actions, while supporting arbitrary limp trees would invent pending action and
opponent ranges that the canonical state does not contain.

## Decision

Route one additional bounded sequence: exactly one canonical player calls to
1 BB, exactly two players remain active, and hero acts from the big blind with
no amount to call. Require no facing action, opener metadata, raise, second
limper, hidden active player, or action behind hero. Validate the pot by replacing
the limper's posted blind, if any, with the represented 1 BB commitment.

Use explicit isolation-raise boundaries keyed by the limper's six-max position.
Widen those boundaries monotonically from UTG through the small blind and apply
the existing stack-depth reraise multiplier. Recommend either check or raise;
target the larger of 4 BB or 1.5 times the pot, capped by the effective stack
behind plus hero's posted big blind. Evidence records the limper and limp size,
named policy, base and adjusted isolation boundaries, target size, stack policy,
and maximum legal raise total.

Decline routing for multiple limpers, more than two active players, a hero seat
other than the big blind, a limp other than 1 BB, contradictory pot or action
state, or any longer history. These states retain the configured range/EV
fallback.

## Consequences

- A common checked-to big-blind decision receives legal check-or-raise guidance.
- Position and stack changes are visible and deterministic rather than implied
  to be solved frequencies.
- Multiway and incomplete limp trees remain outside the bundled chart.
