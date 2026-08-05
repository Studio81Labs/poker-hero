# ADR 0008: Add Heads-Up Four-Bet Response Routing

Status: accepted

## Context

The structured preflop chart can respond to an open or a 3-bet, but it falls
back after hero 3-bets and the original opener 4-bets. This is a common heads-up
training decision. Supporting arbitrary 4-bet trees, however, would require
more players, ranges, and stack state than the transparent chart represents.

## Decision

Route one additional bounded sequence: a 2-4 BB opponent open, one full hero
3-bet, one full 4-bet by the original opener, then hero's decision with exactly
two active players. Require legal opener-before-hero initial action order,
matching structured opener fields, a current call equal to the difference
between the 4-bet and hero 3-bet totals, a pot consistent with blinds and both
current commitments, and known hero and effective stacks sufficient to call.

Use explicit conservative continue/five-bet policies for every legal six-max
opener/hero matchup. Apply ordered 4-bet-to-3-bet size bands and the existing
stack-depth adjustments. Model a five-bet as all-in, capped by the smaller of
hero stack behind plus hero's represented 3-bet and opponent stack behind plus
the represented 4-bet. Evidence records all actors and totals, size ratio and
band, base and adjusted boundaries, stack policy, and all-in cap.

Decline routing for extra active players, a 3-bet by anyone other than hero, a
4-bet by anyone other than the opener, non-full raises, unsupported size ratios,
contradictory money or stack state, or any additional action. These states keep
the configured range/EV fallback.

## Consequences

- A common hero-3-bet/facing-4-bet decision receives deterministic and
  inspectable training guidance.
- Five-bet sizing cannot exceed either represented player's reconstructed total
  stack and never appears outside the continue range.
- The route remains explicitly heads-up and does not imply support for cold
  4-bets, multiple opponents, or arbitrary preflop trees.
- ADR 0010 separately adds a bounded later-player cold 4-bet response only
  after the opener folds and action returns heads-up to hero.
