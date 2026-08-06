# ADR 0027: Verify Contextual Ranges on Later Streets

## Status

Accepted

## Context

Contextual postflop ranges previously stopped at the flop. Turn and river states
retain the current pot and stacks, but the compact current-street action history
cannot distinguish money committed on completed streets from the original flop
pot. Reusing the preflop-derived ranges without that proof could apply stale or
contradictory history.

## Decision

Add `completed_postflop_streets` to detected and canonical state. Each entry is
an ordered, terminal heads-up line for one completed street. Actors alternate
from OOP, wager amounts are total BB committed on that street, and a line must
end with check-check or a matching call. The existing
`postflop_action_history` remains the incomplete current-street line through the
hero decision.

Turn contextual ranges require one completed flop. River contextual ranges
require completed flop and turn entries in order. Sum each actor's final total
on every completed street plus the validated current-street contributions and
subtract them from the visible pot. The remaining amount must match the exact
preflop commitments and blind allowance already required by the contextual
single-raised, 3-bet, or 4-bet profile.

When both visible stacks reconcile with effective stack, restore all represented
postflop contributions and the matching final preflop commitment to reconstruct
starting effective depth. Missing stack evidence retains the explicit 100 BB
assumption, while missing, partial, reordered, nonterminal, or contradictory
street history retains configured ranges.

The solver still starts at the current street. Completed histories verify the
preflop range and stack assumptions; they do not claim to condition hand weights
through an earlier-street solve. Evidence records the decision street and number
of completed streets used for verification.

## Consequences

- Exact turn and river reviews can use actor- and size-aware preflop ranges.
- Persisted states and solver plugins remain compatible because current-street
  history keeps its existing meaning.
- The review UI can capture the missing evidence without inventing actions from
  a screenshot.
- Full range conditioning through earlier-street strategy remains separate
  future work.
