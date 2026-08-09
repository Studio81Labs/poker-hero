# ADR 0038: Centralize the Recommendation Plugin Catalog

## Status

Accepted

## Context

Recommendation provider construction, display labels, and external-service
readiness were maintained in separate conditional blocks. Adding or renaming a
provider required coordinated edits across runtime and capability code, with no
guarantee that the advertised provider matched the implementation that would be
built. Parser plugins already use one descriptor for these concerns.

## Decision

Register each installed recommendation provider as an immutable
`RecommendationPlugin`. The descriptor owns its ID, user-facing label, factory,
and optional availability check.

Use the catalog for runtime construction and pipeline capabilities. Validate
that each factory returns a provider whose runtime name matches the descriptor
ID, and reject duplicate catalog IDs at import time. Keep the configuration
allowlist as a separate deployment-input guard, with a parity test against the
installed catalog.

Local solver engines remain nested options of the `local_solver` provider. They
retain their existing engine allowlist and selection behavior because an engine
does not implement the complete recommendation-provider boundary by itself.
Unknown deployment defaults continue to reach the runtime recommendation flow
so failed jobs preserve their established stored error behavior. Explicit user
selections are still rejected by pipeline validation before execution.

## Consequences

- Recommendation metadata and runtime construction cannot drift independently.
- Adding an installed provider requires one descriptor plus its implementation.
- External provider readiness is reported by the provider that owns the factory.
- Parser and recommendation plugins now expose parallel extension contracts.
- Local solver engine routing and persisted job selections remain compatible.
