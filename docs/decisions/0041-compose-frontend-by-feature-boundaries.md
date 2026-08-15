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

Shared API access separates transport, response decoding, and human-readable
errors from jobs, history, training, benchmark, system, and MCP endpoints. The
stable client barrel preserves the application-facing contract while endpoint
tests stay beside their owning module.

Shared API contracts follow the same ownership split. Poker state,
recommendations, training, jobs, pipeline capabilities, benchmarks, system,
backup, and MCP contracts live in focused `shared/types` modules. The stable
`shared/types.ts` type-only barrel preserves existing feature imports, while
API domain modules import their owning contracts directly.

The workspace feature separates browser-cache validation, mutation leases,
processing-queue persistence, history persistence, and reconciliation into
focused library modules. `workspace/lib/persistence.ts` remains a compatibility
barrel for the page coordinator, not an owner of persistence behavior.

Recommendation presentation follows the same pattern: metadata validation,
parser routing, preflop and postflop evidence, candidate ranking, and formatting
are separate feature-library modules. The existing
`recommendation/lib/recommendationPresentation.ts` path remains a compatibility
barrel so consumers keep a stable contract without becoming coupled to those
implementations.
Postflop evidence further separates solve-tree metadata, generic range context,
limped-pot range derivation, raised-pot range derivation, and final evidence
composition. `recommendation/lib/postflopEvidencePresentation.ts` remains its
two-export compatibility barrel.

Training presentation separates decision comparison and sizing, queue status,
focus ranking, and shared option definitions. Its existing
`training/lib/trainingPresentation.ts` import path remains a compatibility
barrel.

Hand-review state separates card and number parsing, form/canonical conversion,
confidence summaries, stable identity keys, and preflop position normalization.
`hand-review/lib/pokerState.ts` remains the compatibility barrel. Benchmark
presentation consumes the position model from hand review, removing the prior
hand-review-to-benchmark dependency cycle.

The parser benchmark dialog composes focused owners for pipeline comparison,
report overview, result sections, expandable case review, and dataset/run
actions. The dialog itself retains only its public contract, close lifecycle,
ground-truth toggle, and loading or empty-state composition.
Benchmark report comparison, case trends, report caching, parser-route
aggregation, and value formatting are separate library modules behind the
stable `benchmark/lib/benchmarkPresentation.ts` compatibility barrel.

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
- Dense dialogs remain readable composition roots; independently interactive
  sections own their calculations, local disclosure state, and direct tests.
- Shared transport and contract barrels remain compatibility surfaces rather
  than implementation owners; endpoint and type definitions stay in matching
  domain modules.
- Workspace recovery keeps one public import surface while storage schemas,
  lease durability, pagination, and reconciliation can be tested independently.
- Benchmark components and controller code keep one presentation import surface
  without coupling report caching, case comparison, or route aggregation.
- A source-architecture test enforces downward imports between app, page,
  feature, and shared layers. It also keeps feature library and hook code
  independent from UI components and requires colocated component tests. The
  root `main.tsx` bootstrap may import only the application layer; other
  undeclared top-level source locations fail the architecture check. Feature
  production code must live below `components`, `hooks`, or `lib`; feature-root
  barrels and undeclared feature areas are rejected so they cannot conceal
  component dependencies from hooks or libraries. Production modules also may
  not import colocated tests, integration suites, or shared test helpers. TSX
  and CSS feature source must live below `components`, and parsed CSS imports,
  module compositions, value imports, and ICSS imports follow the same layer
  direction as TypeScript imports. The audit rejects JavaScript modules below
  `src` so they cannot bypass the TypeScript source graph, and it resolves
  static Vite glob, `import.meta.url`, and triple-slash path dependencies before
  applying the same boundaries.
- Future reviews should reject new feature-local UI, effects, or transformation
  logic added directly to `App.tsx` or the analyzer page without the matching
  application-level or cross-feature reason.
