# ADR 0024: Derive Three-Bet-Pot Postflop Ranges

## Status

Accepted

## Context

Contextual postflop ranges initially covered only exact single-raised flop
states. Exact heads-up 3-bet pots therefore continued to use one generic OOP/IP
pair even when reviewed preflop history identified the opener, 3-bettor, final
commitments, and sizing. The preflop trainer already owns auditable reraise and
3-bet-defense boundaries for every legal six-max opener/3-bettor matchup.

## Decision

Extend contextual range selection to an exact three-action preflop line:

1. one 2-4 BB open;
2. one later-seat full 3-bet within the chart's supported ratio bands; and
3. one matching call by the original opener.

Exactly two players must remain, both actors must match the reviewed hero and
opponent seats, optional legacy opener fields must agree, and the reconstructed
flop-root pot must match the actors' final commitments plus the blind allowance.
Any missing or contradictory evidence retains the configured ranges.

The 3-bettor range uses the matchup's open-defense reraise boundary adjusted by
the open-size policy. The opener's call range uses the matchup's 3-bet-defense
continue boundary adjusted by the 3-bet-to-open ratio, excluding the stronger
4-bet segment. Both use the chart's standard-stack adjustment because the
compact postflop state does not reliably preserve the preflop starting stack.
The resolved postflop position assigns those ranges to OOP and IP.

The solver records a distinct `preflop_chart_three_bet_pot` source, exact ranges,
actors, sizes, policy bands, and adjusted boundaries in recommendation evidence.
Turn and river states remain on configured ranges because their flop-root pot
cannot be proven from the compact state.

## Consequences

- Common reviewed 3-bet pots no longer use unrelated generic ranges.
- Size-sensitive assumptions remain inspectable and benchmarkable.
- Ambiguous, cold-call, squeeze, 4-bet, limped, and multiway histories keep the
  configured fallback rather than borrowing a nearby profile.
- A future canonical hand-history model could safely extend contextual ranges
  across later streets and additional preflop trees.
