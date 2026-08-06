# ADR 0020: Add a Five-Limper Big-Blind Response

Status: accepted

## Context

The structured preflop chart can respond to one through four limpers when
action reaches hero's big-blind option. The terminal six-max case has one fully
observable sequence: all five other seats limp, all six players remain active,
and the pot is 6 BB. This common training spot currently falls back despite
having no seat-order ambiguity.

## Decision

Route exactly five ordered 1 BB calls before hero in the big blind only when all
six players remain active. Require the canonical UTG, Hijack, Cutoff, Button,
and Small Blind sequence, no facing aggression or legacy opener metadata, and a
pot reconstructed from the blinds plus all five final commitments.

Use one explicit 6% full-table raise policy. Keep it tighter than every
four-limper subset and apply the existing stack-depth adjustment. Target the
larger of 8 BB or 1.5x the pot, capped by the effective total represented by
hero's posted big blind and effective stack. Reuse the multi-limper evidence
contract to record all five seats, count, named policy, base and adjusted range,
target, and cap.

Decline routing for a mismatched player count, duplicate or out-of-order seats,
non-call actions, non-1 BB totals, a non-big-blind hero, an overlong history, or
contradictory pot state. These states retain the configured range/EV fallback.

## Consequences

- Every canonical six-max limp-to-the-big-blind count now receives
  deterministic, inspectable training guidance.
- The full-table policy remains visibly tighter than all four-limper subsets.
- Arbitrary limp trees and action after hero remain outside the bundled chart.
- The response is a conservative training chart, not a solved mixed-frequency
  preflop game tree.
