# ADR 0023: Derive Single-Raised-Pot Postflop Ranges

## Status

Accepted

## Context

The postflop solver previously applied one configured OOP/IP range pair to every
supported heads-up hand. That is a useful fallback but ignores complete reviewed
preflop evidence, so button-open/big-blind-call and other single-raised pots
could enter the same tree with ranges unrelated to the recorded actors.

The existing preflop trainer already owns transparent position-specific opening,
continuing, and reraising boundaries over one deterministic 169-class hand
ordering. Reusing those boundaries keeps the new behavior auditable without
claiming that the chart is a solved preflop game tree.

## Decision

Add `POKER_POSTFLOP_SOLVER_RANGE_MODE`, defaulting to `contextual`. When a
postflop state contains exactly two active players and exactly one 2-4 BB raise
followed by a matching call, the backend derives:

- the opener range from that seat's first-in chart boundary; and
- the caller range from the matchup's continue boundary after excluding the
  stronger segment assigned to a preflop reraise and applying the chart's
  existing adjustment for the reviewed open size.

Both action actors must match the reviewed hero and opponent seats. Optional
legacy opener position and size fields must agree within the established money
tolerance. The resolved relative position assigns the two ranges to OOP and IP.
The plugin still inserts the observed hero combination so an out-of-policy hand
can be reviewed rather than rejected.

Any incomplete, contradictory, differently sized, multiway, limped, or reraised
history retains the configured OOP/IP ranges. `configured` mode disables all
contextual selection. The solver records `range_source`, the exact ranges, and
the chart policy context in recommendation evidence.

## Consequences

- Common reviewed single-raised pots use ranges consistent with their recorded
  preflop actors instead of one generic pair.
- Range assumptions remain inspectable and benchmarkable.
- Existing deployments can preserve explicit static ranges with one setting.
- Broader limped and reraised range profiles remain separate future work rather
  than being inferred from incomplete evidence.
