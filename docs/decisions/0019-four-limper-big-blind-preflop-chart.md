# ADR 0019: Add a Four-Limper Big-Blind Response

Status: accepted

## Context

The structured preflop chart can respond to one through three limpers when
action reaches hero's big-blind option. Four exact calls with five active
players are equally reconstructible, but currently fall back despite being a
common low-stakes training spot. A four-limper response also needs a tighter
isolation range than the existing three-limper policies.

## Decision

Route exactly four ordered 1 BB calls before hero in the big blind only when
exactly five players remain active. Require distinct limper seats in legal
six-max action order, no facing aggression or legacy opener metadata, and a pot
reconstructed from blinds plus all four commitments.

Use an explicit raise policy for each of the five legal four-limper seat
combinations. Keep each range tighter than every corresponding three-limper
triple and apply the existing stack-depth adjustment. Target the larger of 7 BB
or 1.5x the pot, capped by the effective total represented by hero's posted big
blind and effective stack. Reuse the multi-limper evidence contract to record
all four seats, count, named policy, base and adjusted range, target, and cap.

Decline routing for a hidden active player, a fifth limp, duplicate or
out-of-order seats, non-call actions, non-1 BB totals, a non-big-blind hero, or
contradictory pot state. These states retain the configured range/EV fallback.

## Consequences

- A common four-limper big-blind option receives deterministic, inspectable
  training guidance.
- The four-seat policies remain visibly distinct from wider-field policies.
- Five limpers, action after hero, and arbitrary limp trees remain outside the
  bundled chart.
- The response is a conservative training chart, not a solved mixed-frequency
  preflop game tree.
