# ADR 0031: Derive Limped-Pot Postflop Ranges

Status: accepted

## Context

The preflop trainer already validates one exact six-max line where one player
limps to 1 BB, every other player folds, and the big blind checks. It also
defines a position- and stack-aware isolation-raise boundary for the big blind.
The postflop solver nevertheless started these reviewed heads-up pots from
generic configured ranges.

The chart does not model a separate limp-versus-raise decision for the first
player. Treating the limper as an opener or assuming an unreviewed raise would
overstate the evidence available from the screenshot.

## Decision

Recognize exactly one 1 BB call followed by an implicit big-blind check when the
reviewed survivors are that limper and the big blind. Require two active
players, no opener metadata or additional preflop action, legal six-max seat
order, and a reconstructed flop-root pot that matches the blinds and limp.

Use the limper's existing stack-adjusted first-in chart range as an explicitly
labeled proxy for voluntary entry. Use the complement of the chart's adjusted
isolation-raise band as the big blind's checked range. Record both policy
boundaries, the proxy model, actors, limp size, stack source, and a distinct
`preflop_chart_limped_pot` source.

An exact small-blind limp with the big blind as the other survivor also resolves
their otherwise ambiguous relative position according to the reviewed six-max
line. Apply the same completed-history verification and later-street range
conditioning contract as the other contextual ranges.

## Consequences

- Exact heads-up limped pots no longer start from unrelated generic ranges.
- Evidence distinguishes the modeled limper proxy from an observed raise range.
- Multiple limpers, raised limp trees, missing survivor seats, stale opener
  metadata, and contradictory root pots retain configured ranges or fallback.
