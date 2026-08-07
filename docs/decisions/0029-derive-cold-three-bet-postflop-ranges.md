# ADR 0029: Derive Cold-Three-Bet Postflop Ranges

## Status

Accepted

## Context

The preflop trainer already models a conservative response when an opponent
opens, another opponent 3-bets, and hero acts as a distinct cold-caller. If hero
calls and the opener folds, the postflop solver previously retained generic
configured ranges even though both surviving policies and the opener's dead
contribution were reviewable from structured history.

Treating this as an ordinary 3-bet pot would be incorrect. The caller is not the
original opener, and omitting the folded opener's commitment would understate
the flop-root pot.

## Decision

Recognize an exact three-action history containing an open, a full supported
3-bet, and a matching call by a third later seat. Require exactly two active
players whose reviewed seats are the 3-bettor and cold-caller, strict canonical
seat order, supported sizing, consistent optional opener metadata, and a
reconstructed flop-root pot containing all three commitments.

Use the existing adjusted open-defense reraise band for the 3-bettor. Use the
existing three-seat cold-3-bet continue band for the caller after excluding its
4-bet segment. Apply the supported open-size, 3-bet-size, and reconstructed
stack-depth policies. The folded opener contributes dead money but receives no
postflop range and does not participate in effective-stack reconstruction.

Expose a distinct `preflop_chart_cold_three_bet_pot` range source plus the
folded opener, dead commitment, surviving seats, policy boundaries, sizes, and
stack source. Later-street verification and range conditioning use the same
completed-history requirements as other contextual postflop ranges.

## Consequences

- Exact cold-call 3-bet pots no longer start from generic configured ranges.
- Dead opener money remains explicit and testable in recommendation evidence.
- Hidden survivors, ambiguous relative position, unsupported sizes, or
  contradictory history retain configured ranges or the existing fallback.
- Squeeze pots and other broader dead-money trees remain separate profiles
  until both surviving preflop ranges can be derived without guessing.
