# ADR 0025: Derive Four-Bet-Pot Postflop Ranges

## Status

Accepted

## Context

Contextual postflop ranges cover exact single-raised and 3-bet flop states, but
an exact heads-up 4-bet pot still used generic configured ranges. The preflop
trainer already defines matchup-specific 4-bet boundaries for the opener and
continue/five-bet boundaries for the original 3-bettor.

## Decision

Extend contextual range selection to an exact four-action preflop line:

1. one 2-4 BB open;
2. one later-seat full 3-bet within the supported ratio bands;
3. one full 4-bet by the original opener within the supported ratio bands; and
4. one matching call by the original 3-bettor.

Exactly two players must remain, both actors must match the reviewed hero and
opponent seats, optional legacy opener fields must agree, and the reconstructed
flop-root pot must match the actors' final commitments plus the blind allowance.
Any missing or contradictory evidence retains the configured ranges.

The opener range uses the matchup's 4-bet boundary after the 3-bet-size
adjustment. The original 3-bettor's call range uses the matchup's continue
boundary after the 4-bet-size adjustment, excluding the stronger 5-bet segment.
Both use the chart's standard-stack adjustment because the compact postflop
state does not reliably preserve the preflop starting stack. The resolved
postflop position assigns those ranges to OOP and IP.

The solver records a distinct `preflop_chart_four_bet_pot` source, exact ranges,
actors, sizes, policy bands, and adjusted boundaries in recommendation evidence.
Turn and river states remain on configured ranges because their flop-root pot
cannot be proven from the compact state.

## Consequences

- Common reviewed 4-bet pots no longer use unrelated generic ranges.
- Size-sensitive assumptions remain inspectable and benchmarkable.
- Cold 4-bets, five-bet pots, limped, multiway, and contradictory histories keep
  the configured fallback rather than borrowing a nearby profile.
- A future canonical hand-history model could safely extend contextual ranges
  across later streets and additional preflop trees.
