# ADR 0041: Compose the Frontend by Feature Boundaries

## Status

Accepted

## Context

The control panel accumulated capture, queue recovery, hand correction,
training, recommendation, benchmark, metadata, and dialog behavior in
`App.tsx`. The root component mixed deterministic poker transformations,
feature-local asynchronous state, and page rendering with the cross-feature
queue/history mutation protocol. This made otherwise focused changes depend on
one very large implementation and encouraged further growth in the same file.

Moving all root code into a single custom hook would preserve the same coupling
behind a different name. Splitting every callback into an isolated hook would
also obscure the persistence transactions that intentionally coordinate queue
and history state.

## Decision

Compose the frontend using three explicit boundaries:

- `src/app` contains non-React domain, presentation, and persistence support.
- Feature hooks own feature-local state, effects, requests, and commands.
- Feature components own dialogs, panels, and form rendering.

`App.tsx` remains the page composition root and owns the queue/history mutation,
lease, recovery, and automation coordination that spans multiple features. It
passes explicit state and commands into feature hooks and components. New
feature behavior belongs in the closest existing boundary; it may enter
`App.tsx` only when it participates in cross-feature orchestration.

## Consequences

- Feature rendering and lifecycles can be tested without reproducing the full
  application coordinator.
- Poker, persistence, benchmark, recommendation, and training support no longer
  depends on React rendering.
- Queue/history recovery stays centralized and reviewable instead of being
  fragmented across feature hooks.
- `App.tsx` can remain larger than a conventional page component, but its size
  now represents explicit orchestration rather than embedded feature UIs and
  domain algorithms.
- Future reviews should reject new feature-local UI, effects, or transformation
  logic added directly to `App.tsx` without a cross-feature reason.
