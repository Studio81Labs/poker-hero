# ADR 0015: Add a Heads-Up Isolation-Raise Response

Status: accepted

## Context

The structured preflop chart can isolate one limper from the big blind and can
respond after hero calls an open and faces a squeeze. It does not cover the
distinct case where hero limps first, a later player isolation-raises, every
other player folds, and action returns heads-up to hero. Treating that sequence
as an open and 3-bet would misstate both hero's commitment and the actors shown
in recommendation evidence.

## Decision

Route exactly one 1 BB hero call followed by one later-position raise to 2-5 BB
only when exactly two players remain active. Require legal seat order, no opener
metadata, known hero and effective stacks, a current call equal to the raise
minus hero's limp, and a pot reconstructed from blinds plus both commitments.

Apply an explicit continue/reraise policy for every legal hero-limper and
isolation-raiser seat pair. Adjust those boundaries with ordered small,
standard, and large isolation-size bands and the existing stack-depth policy.
Target a limp-reraise at the larger of 3x the isolation raise or 1.1x the pot,
capped by hero stack plus the prior limp and opponent stack plus the represented
raise. Record isolation-specific actor, size, ratio, policy, adjusted ranges,
and cap in recommendation evidence.

Decline routing when another player remains active, hero is not the limper, the
raiser acted earlier, action is still pending, an amount is outside the bounded
policy, or stack and pot state are incomplete or contradictory. These states
retain the configured range/EV fallback.

## Consequences

- A common limp/raise decision receives deterministic and inspectable guidance.
- The UI describes the action as an isolation response rather than a 3-bet.
- Multiway limped pots, multiple raises, and arbitrary preflop trees remain
  outside the bundled chart.
