# ADR 0039: Centralize the Local Solver Engine Catalog

## Status

Accepted

## Context

The `local_solver` recommendation provider supports the bundled range/EV
engine, the postflop CFR executable, and a deployment-fixed custom command.
Engine IDs and labels were advertised by pipeline code while command parsing
and execution routing were selected through separate provider conditionals.
Adding a licensed or private engine could therefore make runtime behavior drift
from the capabilities shown in the control panel.

## Decision

Register each local solver engine as an immutable `LocalSolverEnginePlugin`.
The descriptor owns its ID, user-facing label, execution mode, subprocess
command factory, and whether it can be selected through a deployment allowlist.
Factories return immutable command specifications carrying the engine ID, argv,
and optional working directory. Reject duplicate IDs and command identity
mismatches.

Use descriptor modes for EV, postflop, and custom-command routing inside
`LocalSolverProvider`. Keep eligibility checks, preflop-chart routing, and the
EV fallback in the provider because those decisions depend on canonical hand
state rather than executable identity. Derive pipeline engine labels and known
IDs from the same catalog.

Treat `custom_local` as an installed but non-selectable descriptor. Supplying
`POKER_LOCAL_SOLVER_COMMAND` fixes the deployment to that engine and preserves
the existing rule that browser requests cannot replace it. Keep the
configuration allowlist as a separate deployment-input guard, with a parity
test against selectable catalog entries.

## Consequences

- Engine command construction and advertised metadata cannot drift.
- A future engine adds one descriptor and its command adapter.
- Existing engine IDs, fallback behavior, and persisted selections remain stable.
- The subprocess JSON contract remains the boundary for private solver plugins.
- Deployment-fixed custom commands remain unavailable as browser choices.
