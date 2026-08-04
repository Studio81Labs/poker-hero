# ADR 0005: Add Structured Preflop Action History

Status: accepted

## Context

The preflop chart can respond to one open through structured opener fields, but
it cannot distinguish a hero open followed by a 3-bet from ambiguous action
text. Falling back in every 3-bet pot leaves a common training spot without
position-aware guidance. Inferring a larger tree from prose, pot size, or button
labels would hide uncertainty and overstate the local chart's capabilities.

## Decision

Add optional ordered `preflop_action_history` to detected and canonical state.
Each action contains a canonical six-max position, `call` or `raise`, and a
finite positive total BB commitment. The review UI owns correction of this
sequence. Dataset exports, parser benchmarks, local cache, and HTTP provider
payloads preserve non-empty histories; older records remain valid with an empty
default.

Extend the transparent preflop chart with one conservative scenario: hero opens
2-4 BB and exactly one later position 3-bets. Eligibility requires two raises in
legal seat order, at least a full second raise, a matching amount to call, a pot
consistent with blinds and both commitments, and enough visible hero stack to
continue. Explicit opener fields, when present, must agree with the first action.

The response uses explicit hero-to-3-bettor matchup boundaries. Ordered
3-bet-to-open ratio bands tighten continue and four-bet fractions as sizing
grows, while the existing stack-depth policy shifts those fractions. A four-bet
target is capped by both players' reconstructed total stacks. Recommendation
evidence includes the action totals, ratio, selected policies, base and adjusted
boundaries, assumptions, and cap. Explanations continue to identify this as a
training chart rather than a solved preflop game tree.

Histories containing calls, limps, more than two actions, an opponent open before
a 3-bet, a cold 4-bet, a squeeze, unsupported positions or sizes, or contradictory
money state decline chart routing and retain the configured fallback behavior.

## Consequences

- Common hero-open/facing-3-bet training spots receive deterministic,
  position-aware raise/call/fold guidance.
- Review corrections no longer depend on action-text wording, and the first
  structured raise remains compatible with existing opener fields.
- Eligibility and policy evidence are directly testable and benchmarkable.
- The policy is still a hand-ranked heuristic chart. It does not model antes,
  ranges conditioned on prior folds, mixed-action equilibrium, callers,
  squeezes, cold 4-bets, tournaments, or arbitrary preflop trees.
- A licensed solver can replace this route behind the provider boundary without
  changing canonical review data.

ADR 0006 later uses the same structured sequence for one open followed by one
caller before hero while preserving fallback for every broader multiway tree.
