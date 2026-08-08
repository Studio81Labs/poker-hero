# ADR 0033: Derive Isolation-Raised-Pot Postflop Ranges

## Status

Accepted

## Context

The preflop chart already defines the big blind's isolation range against one
limper and the original limper's response to a 2-5 BB isolation raise. The
postflop solver nevertheless retained generic configured ranges after the
limper called, even when the exact heads-up continuation was reviewed.

The chart does not define the initial isolation range for non-big-blind seats.
Generalizing this route to every later position would therefore invent policy
evidence that the trainer does not own.

## Decision

Recognize exactly one 1 BB limp, a 2-5 BB isolation raise by the big blind, and
a matching call by that same limper. Require exactly two active players, the
reviewed survivor pair to be the limper and big blind, legal six-max action
order, and a reconstructed flop-root pot that matches both final commitments
plus unrepresented blinds. Call-first structured history takes precedence over
legacy opener metadata.

Use the existing limper-position and stack-adjusted big-blind isolation band as
the raiser's range. Use the existing limper-versus-big-blind defense policy,
adjusted for isolation size and stack depth, as the limper's continuing range;
exclude its limp-reraise segment to obtain the observed call band.

Record a distinct `preflop_chart_isolation_raised_pot` source plus both actors,
both action sizes, named policies, stack source, and base and adjusted range
boundaries. Apply the existing later-street history verification and range
conditioning contract. Non-big-blind isolation raises and incomplete or
contradictory evidence retain configured ranges.

## Consequences

- Exact called big-blind isolation pots start from chart-derived ranges.
- Recommendation evidence distinguishes the raiser's isolation band from the
  limper's call band after excluding limp-reraises.
- The implementation remains honest about the chart's missing non-big-blind
  isolation policies.
- Extra players, mismatched actions, unsupported sizes, ambiguous positions,
  and inconsistent pots keep the existing configured fallback.
