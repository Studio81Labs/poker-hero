# ADR 0006: Add Single-Caller Preflop Chart Routing

Status: accepted

## Context

Ordered preflop history can already distinguish a single open and a hero open
facing one 3-bet. An open followed by one call is another common training spot,
but treating every called pot as the existing heads-up defense would ignore
multiway realization and under-size a squeeze. Broad caller support would also
overstate what the transparent chart can model without complete stacks and
ranges.

## Decision

Route one additional bounded scenario: a 2-4 BB open, exactly one matching call,
then the hero decision. Require canonical opener-caller-hero seat order, exactly
three active players, a call total equal to the open total, a matching amount to
call, and a pot consistent with blinds and both commitments. Structured history
remains authoritative over action text.

Apply a named conservative single-caller policy after the existing opener,
opening-size, and stack adjustments. Multiply both continue and reraise
boundaries by 0.90. Use a squeeze target of at least 4x the open, still capped by
the reconstructed effective total. Label the chart tiers as squeeze, overcall,
or fold. Recommendation evidence records caller seat, caller count, policy name,
multipliers, squeeze multiple, adjusted boundaries, and cap.

Decline routing for limps, more than one caller, more or fewer than three active
players, a caller at or after hero, mismatched call totals, later aggression, or
contradictory pot and call amounts. These states retain the configured range/EV
fallback.

## Consequences

- A common three-player preflop decision receives deterministic position-aware
  training guidance without pretending to solve a multiway game tree.
- Squeeze sizing and response boundaries visibly account for the caller.
- Recommendation benchmarks can distinguish supported single-caller routing
  from fallback cases with hidden players or broader histories.
- At adoption, cold 3-bets were still unsupported; ADR 0007 adds a separate
  bounded policy. Limped pots, multiple callers, cold 4-bets, and arbitrary
  preflop trees still require a licensed solver or future bounded policies.
