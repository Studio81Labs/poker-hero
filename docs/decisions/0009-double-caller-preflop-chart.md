# ADR 0009: Add Bounded Double-Caller Preflop Chart Routing

Status: accepted

## Context

The structured preflop chart can respond to one open followed by one call, but
it still sends an open followed by two calls to the generic range/EV fallback.
This is a common squeeze and overcall decision. Treating every multi-caller pot
as the single-caller route, however, would understate the additional multiway
realization pressure and under-size a squeeze.

## Decision

Route one additional bounded scenario: a 2-4 BB open, exactly two matching
calls, then hero's decision with exactly four active players. Require canonical
opener-caller-caller-hero seat order, distinct represented seats, call totals
equal to the open total, a matching amount to call, and a pot consistent with
the blinds and all three commitments. Structured history remains authoritative
over action text.

Apply a named conservative double-caller policy after the existing opener,
opening-size, and stack adjustments. Multiply the continue boundary by 0.80
and the reraise boundary by 0.85. Use a squeeze target of at least 5x the open,
still capped by the reconstructed effective total. Keep the existing squeeze,
overcall, and fold tiers. Recommendation evidence records both caller seats,
caller count, policy name, multipliers, squeeze multiple, adjusted boundaries,
and cap.

Decline routing when another player remains active, either call is missing or
mismatched, seats repeat or appear out of order, later aggression is present,
or the pot and call amounts are contradictory. Three or more represented
callers and all broader multiway histories retain the configured fallback.

## Consequences

- A common four-player preflop decision receives deterministic and inspectable
  training guidance without being described as a solved multiway game tree.
- The policy is visibly tighter and the squeeze target larger than the
  single-caller route.
- Recommendation benchmarks can distinguish one-caller, two-caller, and
  unsupported broader histories.
- Limped pots, three or more callers, cold 4-bets, and arbitrary preflop trees
  remain outside the bundled chart.
