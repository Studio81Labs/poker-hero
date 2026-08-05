# ADR 0010: Add Bounded Cold Four-Bet Response Routing

Status: accepted

## Context

The structured preflop chart can respond after hero 3-bets and the original
opener 4-bets, but it falls back when a later third player cold 4-bets. A cold
4-bet can leave several players with action pending, so treating every such
history as heads-up would apply the wrong ranges and omit important stack and
dead-money state.

## Decision

Route one additional bounded sequence: a 2-4 BB opponent open, one full hero
3-bet, one full cold 4-bet by a later-position third player, then hero's
decision after the original opener folds. Require exactly two active players,
canonical opener-hero-cold-four-bettor seat order, matching structured opener
fields, a current call equal to the difference between the 4-bet and hero
3-bet totals, and known hero and effective stacks sufficient to call. The pot
must match all three commitments, including the folded opener's dead money and
replaced blinds.

Use explicit conservative continue/five-bet policies for every legal six-max
three-seat order. Apply the existing ordered 4-bet-to-3-bet size bands and
stack-depth adjustments. Model a five-bet as all-in, capped by the smaller of
hero stack behind plus hero's represented 3-bet and opponent stack behind plus
the represented cold 4-bet. Evidence records all three actors and totals, the
named cold 4-bet policy, size ratio and band, base and adjusted boundaries,
stack policy, and all-in cap.

Decline routing when another player remains active, the opener has not folded,
the cold 4-bettor acts before hero, hero did not make the 3-bet, either raise is
not full, the size ratio is unsupported, money or stack state is contradictory,
or any additional action is present. These states retain the configured
range/EV fallback.

## Consequences

- A common heads-up decision after a cold 4-bet receives deterministic and
  inspectable training guidance.
- Folded-opener chips remain part of pot validation instead of disappearing
  from the reconstructed state.
- Every supported three-seat order is explicit and uses a narrower policy than
  the corresponding original-opener 4-bet response.
- Hero-open/two-later-raise lines, cold 4-bets with another active player, and
  arbitrary preflop trees remain outside the bundled chart.
