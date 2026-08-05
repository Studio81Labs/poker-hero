# ADR 0017: Add a Two-Limper Big-Blind Response

Status: accepted

## Context

The structured preflop chart can respond when one player limps and action
reaches hero's big-blind option. It falls back when a second player overlimps,
even though two exact calls, the active-player count, and the blind-only pot
make this common decision reconstructible without guessing. Reusing the
single-limper range would overstate how widely hero should isolate multiway.

## Decision

Route exactly two ordered 1 BB calls before hero in the big blind only when
exactly three players remain active. Require distinct limper seats in legal
six-max action order, no facing aggression or legacy opener metadata, and a pot
reconstructed from blinds plus both commitments.

Use an explicit raise policy for every legal two-limper seat pair. Keep these
ranges tighter than either corresponding single-limper range and apply the
existing stack-depth adjustment. Target the larger of 5 BB or 1.5x the pot,
capped by the effective total represented by hero's posted big blind and the
effective stack. Record both limper positions, count, named policy, base and
adjusted range, target, and cap in recommendation evidence.

Decline routing for a hidden active player, a third limp, duplicate or
out-of-order seats, non-call actions, non-1 BB totals, a non-big-blind hero, or
contradictory pot state. These states retain the configured range/EV fallback.

## Consequences

- A common two-limper big-blind option receives deterministic, inspectable
  training guidance.
- The explicit pair policies avoid presenting a heads-up range as multiway
  strategy.
- Three or more limpers, action after hero, and arbitrary limp trees remain
  outside the bundled chart.
