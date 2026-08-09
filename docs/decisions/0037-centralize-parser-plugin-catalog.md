# ADR 0037: Centralize the Parser Plugin Catalog

## Status

Accepted

## Context

Parser construction, display labels, external-service availability, and layout
compatibility were maintained in separate conditional blocks. Adding or
renaming a parser therefore required coordinated edits across runtime and
capability code, with no guarantee that the advertised plugin matched the
implementation that would be built.

## Decision

Register each installed parser as an immutable `ParserPlugin`. The descriptor
owns its ID, user-facing label, factory, optional availability check, and
optional fixed set of supported layouts. A missing layout set means the parser
accepts deployment-defined profiles.

Use the catalog for runtime construction and pipeline capabilities. Validate
that each factory returns a parser whose runtime name matches the descriptor ID,
and reject duplicate catalog IDs at import time. Keep the configuration
allowlist as a separate deployment-input guard, with a parity test against the
installed catalog.

Unknown deployment defaults continue to reach runtime construction so failed
jobs retain their established stored error behavior. Explicit user selections
are still rejected by pipeline validation before execution.

## Consequences

- Parser metadata and runtime construction cannot drift independently.
- Adding an installed parser requires one descriptor plus its implementation.
- Multi-layout and fixed-layout parsers express compatibility declaratively.
- Recommendation providers remain a separate registry and can adopt the same
  descriptor pattern independently.
