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

Compose the frontend using four explicit boundaries:

- `src/app` owns the router shell, route registry, error boundary, and other
  application-wide concerns.
- `src/pages` owns route-level composition. The analyzer page coordinates the
  queue/history mutation, lease, recovery, and automation transactions that
  span multiple features.
- `src/features` groups components, colocated styles, hooks, and non-React
  support by product domain.
- `src/shared` contains reusable UI controls, API access, primitive types, and
  domain-independent helpers.

`App.tsx` remains deliberately small and mounts the route registry. The
analyzer page passes explicit state and commands into feature hooks and
components. New feature behavior belongs in the closest existing boundary; it
may enter a page coordinator only when it participates in cross-feature
orchestration. New top-level experiences receive their own page and route.

## Consequences

- Feature rendering and lifecycles can be tested without reproducing the full
  application coordinator.
- Page styles describe page composition; feature and shared-component selectors
  are loaded by their owning component boundary.
- Poker, persistence, benchmark, recommendation, and training support no longer
  depends on React rendering.
- Queue/history recovery stays centralized and reviewable instead of being
  fragmented across feature hooks.
- The application shell is ready for authentication and account routes without
  coupling those experiences to the analyzer workspace.
- The analyzer page can remain larger than a conventional component, but its
  size represents explicit orchestration rather than embedded feature UIs and
  domain algorithms.
- Component tests are colocated with their owners, while analyzer integration
  tests are grouped by workflow domain.
- Future reviews should reject new feature-local UI, effects, or transformation
  logic added directly to `App.tsx` or the analyzer page without the matching
  application-level or cross-feature reason.
