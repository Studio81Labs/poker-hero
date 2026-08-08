# ADR 0034: Derive Limp-Reraised-Pot Postflop Ranges

## Status

Accepted

## Context

The preflop trainer already models two sides of an exact heads-up line: an
original limper's reraise response to a later isolation raise and the
isolator's continue or 4-bet response. After the isolator called, however, the
postflop solver still used generic configured ranges despite having the full
reviewed action and both surviving actors.

Treating the original limp-reraise as an ordinary 3-bet would hide its much
tighter chart boundary and discard the isolation-size evidence.

## Decision

Recognize exactly one 1 BB limp, one later-position isolation raise to 2-5 BB,
one full reraise by the original limper no larger than 4x the isolation total,
and one matching call by the isolation raiser. Require exactly two active
players, legal six-max actor order, the reviewed survivor pair to represent
those actors, and a reconstructed flop-root pot matching both final
commitments plus unrepresented blinds. Call-first structured history takes
precedence over legacy opener metadata.

Use the original limper's isolation-response reraise boundary, adjusted for
isolation size and reconstructed stack depth, as the limp-reraiser's range. Use
the isolator's matchup-specific limp-reraise continue boundary, adjusted for
the reraise-to-isolation ratio and stack depth, after excluding its 4-bet band
as the observed call range.

Record a distinct `preflop_chart_limp_reraised_pot` source plus every actor and
amount, both named response policies, both sizing policies, stack source, and
base and adjusted range boundaries. Apply the existing later-street history
verification and range-conditioning contract. The exact six-max actor order
may establish relative position when reviewed values use concrete, relative,
or consistent mixed labels, including small blind OOP versus big blind IP. A
reviewed dealer/button alias instead identifies that action actor as the
heads-up small blind and preserves its postflop IP assignment.

## Consequences

- Exact called limp-reraised pots use ranges tied to their reviewed action.
- Evidence distinguishes the limper's reraise band from the isolator's call
  band after excluding 4-bets.
- The blind-only survivor pair can reach the production postflop solver under
  the exact six-max chart contract.
- Extra players, mismatched actors or calls, incomplete or oversized raises,
  contradictory labels, and inconsistent pots retain configured ranges.
