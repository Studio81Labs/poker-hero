# ADR 0021: Track Multiway Current-Wager Commitments

Status: accepted

## Context

The bundled range/EV fallback evaluates multiway raises by caller count. The
canonical pot already includes outstanding wagers, but a scalar call amount
does not reveal whether one or several opponents have committed that amount.
Subtracting a single wager therefore overstates continuation pots after an
initial bet has already received calls.

## Decision

Add the optional canonical field `opponents_at_current_bet`. For a multiway
state facing a wager, the bundled range/EV fallback requires this reviewed
count before recommending an action. Heads-up states infer one committed
opponent. Supported preflop chart routes, custom solver commands, and external
providers keep their existing contracts.

Under the fallback's independent equal-response model, a branch with `k`
callers out of `N` opponents contains an expected `k * committed / N` callers
whose current wager is already included in the pot. The fallback subtracts
that expected commitment before calculating the branch's final pot and EV.

## Consequences

- Multiway continuation pots account for initial bets plus existing callers.
- The review UI exposes the count only when a multiway state faces a wager.
- Automation may approve such a state, but recommendation waits for this
  manually reviewed context when the fallback route needs it.
- Existing persisted states remain valid because the field is optional.
