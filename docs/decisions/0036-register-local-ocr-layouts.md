# ADR 0036: Register Local OCR Layouts

## Status

Accepted

## Context

Pipeline capabilities distinguish parser providers from table layout profiles,
but the deterministic OCR implementation historically kept every calibrated
region as a module-level constant. Its layout setting was metadata rather than
an execution boundary, and an unknown value could fall back to the
Fortuna/Nations coordinates. That made a future client profile easy to advertise
without actually routing its geometry through every OCR stage.

## Decision

Represent each installed local OCR layout as an immutable `OcrLayout`. A layout
owns its reference dimensions, card slots, pot and action-control regions, hero
stack region, rank subregions, numeric read settings, stakes header, opponent
seats, recognition-engine identity, and compatible capture geometry.
Card, numeric, stack, seat, and money-scaling reads receive the resolved layout
explicitly.

Register `generic`, `fortuna`, `nations`, and `fortuna_nations` as aliases for
the existing calibrated Fortuna/Nations engine. Keep these aliases until stored
jobs and deployment configuration can migrate to a single canonical name.
Unknown local layout IDs fail during parser construction; local OCR never falls
back to another client's regions. External vision remains free to accept
deployment-defined profile IDs through its separate provider boundary.
Before recognition, local OCR also rejects captures that are too small for its
calibrated regions or whose aspect ratio falls outside the layout's declared
tolerance. An incompatible capture must not continue with fixed coordinates and
return plausible but unrelated table values.

## Consequences

- Adding a local client starts with one registry entry and an explicit geometry
  object instead of editing parsing control flow.
- Every fixed-region read uses the same selected coordinate system.
- Incompatible and thumbnail captures fail with an actionable parser error
  before any fields are extracted.
- Existing Fortuna/Nations jobs preserve their profile IDs and parser output.
- PokerStars remains external-only until its screenshot corpus, geometry, and
  recognition behavior are calibrated and registered locally.
