# ADR 0028: Condition Later-Street Ranges Through Reviewed Actions

## Status

Accepted

## Context

Turn and river recommendations can reconstruct the original flop pot, stack,
and starting ranges from reviewed preflop and completed-street histories. The
solver previously used those histories only as consistency evidence, so both
players still entered a later-street tree with their unconditioned flop ranges.
This ignored the information revealed by earlier checks, bets, raises, and
calls.

A single unrestricted flop-root tree would condition the ranges and answer the
current decision together, but a representative 100 BB tree exceeds the
default compressed-memory ceiling. Raising that ceiling would make ordinary
training requests depend on substantially larger containers and longer solves.

## Decision

Use two sequential solves when the current state contains every terminal prior
street, both visible stacks reconcile with effective stack, and the visible pot
reconstructs a positive flop root.

The first solve starts on the flop with the selected starting ranges. It
preserves every reviewed bet and raise size on completed streets, retains the
configured bet size on future streets, and omits raises that were not observed
in the reviewed line. After solving, replay the completed actions and actual
turn or river cards. Use each player's resulting reach weights as the input
ranges for a second, normal current-street solve with the fully configured bet
and raise profile.

The conditioning solve uses the existing iteration, exploitability, rake, and
memory settings. It runs and releases its tree before the decision tree is
allocated. If its estimated compressed tree exceeds the configured memory
ceiling or a player's reviewed line has zero reach, retain the selected starting
ranges and report that conditioning was skipped. Preserve the known hero hand
with a minimal positive weight when the approximate prior solve assigns its
reviewed line zero probability.

Recommendation evidence identifies the conditioning mode, completed streets,
replayed line, downstream-tree simplification, active hands, hero line reach,
memory estimate, and exploitability.

## Consequences

- Turn and river recommendations respond to the information in reviewed prior
  actions instead of treating every selected preflop hand as equally reachable.
- The current decision keeps the existing configurable action tree and EV
  output.
- Peak memory stays bounded because the conditioning and decision trees are
  solved sequentially.
- Prior-street frequencies are an explicit approximation because unobserved
  raises are omitted from the conditioning tree. Trusted recommendation
  benchmarks should measure whether expanding that profile is worth the added
  memory and latency.
- Incomplete histories and missing stack evidence retain existing behavior.
