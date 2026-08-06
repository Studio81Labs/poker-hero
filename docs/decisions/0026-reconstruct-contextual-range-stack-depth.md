# ADR 0026: Reconstruct Contextual Range Stack Depth

## Status

Accepted

## Context

Contextual single-raised, 3-bet, and 4-bet flop ranges use the preflop chart's
size adjustments, but previously applied its 100 BB standard-stack policy to
every hand. The canonical state already records the effective stack behind and
can optionally record both visible stacks plus ordered current-street actions.
Those reviewed values can identify the preflop starting depth in common cases.

## Decision

Apply a reconstructed starting effective stack to contextual postflop ranges
when the money state is sufficient and internally consistent.

With no current-street wager, add the two players' matching final preflop
commitment to the reviewed effective stack behind. Once postflop money is
wagered, require both visible stacks, require their minimum to match the
reviewed effective stack, and restore either the explicit first bet or validated
ordered OOP/IP contributions through the hero decision. Then add the matching
final preflop commitment.

Select the existing short, medium, standard, or deep chart policy from that
starting depth. The policy adjusts every applicable range boundary, including
the opener's range in a single-raised pot. Record the starting depth, selected
policy, and `reconstructed` source in range evidence.

Missing or contradictory stack evidence must not block an otherwise exact
preflop history and root-pot match. Preserve the prior 100 BB behavior in that
case and record `standard_assumption` as the depth source. Do not infer a
post-wager starting depth from only one visible stack.

## Consequences

- Reviewed short and deep hands no longer borrow 100 BB range boundaries.
- The solver evidence distinguishes measured reconstruction from a default
  assumption.
- Existing screenshots without both visible stacks remain compatible.
- Improving opponent-stack recognition increases range accuracy for postflop
  decisions after money enters the current street.
