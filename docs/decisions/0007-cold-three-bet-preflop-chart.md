# ADR 0007: Add Bounded Cold 3-Bet Chart Routing

Status: accepted

## Context

Structured preflop history can distinguish a hero open facing a later 3-bet,
but it still sends every opponent-open/opponent-3-bet decision to the generic
range/EV fallback. This is a common training spot, yet broad squeeze-pot support
would overstate the precision of a transparent 169-hand chart when players or
actions are hidden.

## Decision

Route one additional bounded scenario: a 2-4 BB opponent open, one full
opponent 3-bet, then hero's decision with exactly three active players. Require
canonical opener-3-bettor-hero seat order, matching structured opener fields,
a call amount equal to the 3-bet total minus hero's posted blind, a pot
consistent with blinds and both opponent commitments, and known hero and
effective stacks sufficient to call. Structured history remains authoritative
over action text.

Use an explicit conservative continue/four-bet policy for every legal six-max
three-seat order. Apply the existing 3-bet-size and stack-depth adjustments.
Four-bet sizing uses the existing target formula, but its hero-side cap adds
only hero's actual posted blind to stack behind. Recommendation evidence records
the opener, 3-bettor, both totals, size ratio and band, named cold 3-bet policy,
base and adjusted boundaries, stack policy, and maximum legal four-bet total.

Decline routing when another player remains active, action order is invalid, the
second raise is not full, money or stack state is contradictory, the size ratio
is unsupported, or the history contains any additional action. These states
retain the configured range/EV fallback.

## Consequences

- A common cold 3-bet decision receives deterministic, inspectable training
  guidance without being described as a solved preflop tree.
- Blind call amounts and all-in caps are reconstructed from hero's real prior
  commitment instead of the opponent's opening size.
- Every supported seat order is explicit and testable; unrepresented multiway
  state cannot silently use a heads-up chart.
- Limped pots, multiple callers, cold 4-bets outside ADR 0010's bounded
  heads-up response, and longer preflop trees remain outside the bundled chart.
