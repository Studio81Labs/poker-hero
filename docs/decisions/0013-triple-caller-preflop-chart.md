# ADR 0013: Add Bounded Triple-Caller Preflop Routing

Status: accepted

## Context

The structured preflop chart routes an open followed by one or two calls, but a
fully represented third call still uses the generic range/EV fallback. This is
a common blind decision and fits the existing ordered action model. Supporting
arbitrary multiway histories, however, would overstate a transparent hand-ranked
training chart.

## Decision

Route one additional bounded sequence: one supported 2-4 BB open followed by
exactly three matching calls before hero. Require exactly five active players,
five distinct canonical seats in legal action order, a current call matching
the open minus hero's blind, and a pot reconstructed from all four commitments
with replaced blinds.

Apply a named conservative triple-caller policy after the existing hero-versus-
opener, open-size, and stack-depth adjustments. Multiply the adjusted continue
boundary by 0.70 and the squeeze boundary by 0.80. Target a squeeze at the larger
of 6x the open or 1.1x the pot, capped by the existing effective total. Evidence
records all three callers, the policy and multipliers, target multiple, adjusted
boundaries, and maximum legal raise total.

Decline routing for a hidden active player, fourth caller, nonmatching call,
repeated or out-of-order seat, later aggression, contradictory pot or call
amount, or any longer history. These states retain the configured range/EV
fallback.

## Consequences

- A common five-way blind decision receives deterministic and inspectable
  training guidance.
- The response becomes progressively tighter from one through three callers.
- Four-caller and arbitrary multiway trees remain outside the bundled chart.
