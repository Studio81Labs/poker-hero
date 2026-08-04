# ADR 0003: Add Structured Preflop Opener Context

Status: accepted

## Context

The first preflop chart integration inferred opener position and total opening
size from free-text action context. That preserved compatibility with existing
approved hands but made routing sensitive to OCR wording and forced the chart to
reconstruct blind action from pot and call amounts.

## Decision

Add optional `preflop_opener_position` and `preflop_open_size` fields to detected
and canonical state. The review UI exposes them only when the hand is preflop and
hero faces a raise. The chart prefers structured values, validates the opening
size against the amount to call and hero's posted blind, applies opener-to-hero
matchup and opening-size-adjusted response boundaries, and records resolved
opener and policy evidence in recommendation metadata.

Free-text parsing remains a fallback for persisted jobs and schema-version 1
datasets that predate these fields. Dataset exports omit unlabeled optional
values, so adding the fields does not create artificial ground-truth labels.

## Consequences

- User-reviewed opener evidence no longer depends on prose formatting.
- Existing jobs and datasets remain valid without migration.
- Future parsers can emit field confidence for opener evidence independently.
- Full limper, caller, ante, and multi-raise support still requires structured
  action history beyond a single opener.

ADR 0005 later adds that ordered history for single opens and one narrowly
supported hero-open/facing-3-bet route. The opener fields remain as a backward-
compatible projection of the first raise.
