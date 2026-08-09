# ADR 0035: Benchmark Postflop Range Sources

## Status

Accepted

## Context

The local postflop solver can derive starting ranges from nine exact preflop
histories or retain configured ranges. The recommendation benchmark already
measures strategy agreement and later-street range conditioning, but it cannot
detect a valid solve that silently selected the wrong starting-range profile.

Treating missing source metadata as a mismatch alone would also hide the
difference between a routing regression and incomplete provider evidence.

## Decision

Add recommendation benchmark schema version 4. A flop, turn, or river case may
declare `expected_range_source` as `configured` or one of the registered
`preflop_chart_*_pot` source values. Versions 1 through 3 remain readable when
that field is absent.

Read actual evidence only from an exact recognized `raw.range_source` value.
For cases with an expectation, report source agreement across evaluated cases
and source evidence coverage across all expected cases. Provider failures and
missing, padded, malformed, or unknown values lower coverage. A recognized but
different source lowers agreement.

Expose both metrics in JSON, human-readable aggregate, street, and tag reports.
Add independent minimum-accuracy and minimum-coverage CLI thresholds so trusted
corpora can reject either class of regression.

## Consequences

- Trusted corpora can pin every supported contextual range route explicitly.
- Missing metadata cannot make range routing appear correct.
- Reports distinguish wrong routing from absent evidence.
- Preflop cases cannot declare a postflop range-source expectation.
- New corpora use schema version 4; older corpora continue to run unchanged.
