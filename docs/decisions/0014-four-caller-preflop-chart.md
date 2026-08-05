# ADR 0014: Add the Terminal Six-Max Called-Open Route

Status: accepted

## Context

The structured preflop chart routes an open followed by up to three calls. One
fully represented called-open sequence remains possible in six-max: UTG opens,
every intermediate seat calls, and the big blind closes the action. This state
fits the existing model without implying support for arbitrary longer trees.

## Decision

Route exactly one open followed by four matching calls only when all six
canonical seats are represented in the fixed UTG-hijack-cutoff-button-small-
blind-big-blind order and hero is the big blind. Require six active players, a
current call equal to the open minus hero's posted blind, and a pot reconstructed
from the opener plus all four callers with replaced blinds.

Apply a named conservative four-caller policy after the existing matchup,
open-size, and stack-depth adjustments. Multiply the adjusted continue boundary
by 0.60 and the squeeze boundary by 0.75. Target a squeeze at the larger of 7x
the open or 1.1x the pot, capped by the existing effective total. Evidence
records every caller, the policy and multipliers, target multiple, adjusted
boundaries, and maximum legal raise total.

Decline routing for any missing, duplicate, or out-of-order seat, a nonmatching
call, later aggression, a fifth call, contradictory pot or call amount, or any
other five-action history. These states retain the configured range/EV fallback.

## Consequences

- Called-open chart coverage now spans every representable six-max caller count.
- The terminal response is deterministic, tight, and visibly distinct from
  solved multiway frequencies.
- There is no further caller-count route to add without changing the game model.
