# ADR 0011: Add Bounded Squeeze Response After Hero Calls

Status: accepted

## Context

The structured preflop chart can recommend a squeeze when hero has not acted,
but it falls back after hero cold-calls an open and a later player squeezes.
This is a useful training decision, yet broad squeeze-pot support would leave
the opener or other callers with action pending and would overstate what a
transparent hand-ranked chart represents.

## Decision

Route one additional bounded sequence: a 2-4 BB opponent open, one matching
hero cold-call, one full squeeze by a later-position opponent, then hero's
decision after the original opener folds. Require exactly two active players,
canonical opener-hero-squeezer seat order, matching structured opener fields,
a current call equal to the squeeze minus hero's prior call, and known hero and
effective stacks sufficient to continue. The pot must match all three
commitments, including the folded opener's dead money and replaced blinds.

Use explicit conservative continue/four-bet policies for every legal six-max
three-seat order. Apply the existing ordered 3-bet-to-open size bands and
stack-depth adjustments. Cap a four-bet by the smaller of hero stack behind
plus hero's prior call and opponent stack behind plus the represented squeeze.
Evidence records all three actors and totals, hero's prior call, the named
squeeze-response policy, size ratio and band, adjusted boundaries, stack policy,
and maximum legal four-bet total.

Decline routing when the opener remains active, another player is active, hero
did not make the matching call, the squeezer does not act later than hero, the
squeeze is not full or exceeds the supported size band, money or stack state is
contradictory, or any additional action is present. These states retain the
configured range/EV fallback.

## Consequences

- A common heads-up response after hero cold-calls receives deterministic and
  inspectable training guidance.
- Hero's prior call and the folded opener's dead money remain part of stack and
  pot reconstruction.
- Every supported seat order is explicit and uses a tighter policy than the
  corresponding opener response to the same 3-bettor.
- Squeezes with an active opener, another caller, action behind, or arbitrary
  preflop history remain outside the bundled chart.
