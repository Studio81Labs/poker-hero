# ADR 0022: Infer Heads-Up Postflop Relative Position

## Status

Accepted

## Context

The postflop plugin requires hero to be identified as in position or out of
position. Approved hands often retain absolute six-max seats instead. A button
label is already unambiguously IP, but labels such as big blind or cutoff were
routed to the range/EV fallback even when the opponent seat made their relative
order clear.

## Decision

Canonical parser and approved state may include an optional
`opponent_position`. For heads-up postflop decisions, the local provider and
the Rust plugin resolve hero's relative position in this order:

1. Consistent explicit hero or opponent `IP`/`OOP` labels.
2. A hero or opponent button/dealer label.
3. The postflop order of two distinct normalized six-max seats.

Aliases normalize to UTG, hijack, cutoff, button, small blind, or big blind.
Contradictory labels, duplicate seats, unknown labels, and a bare small-blind
versus big-blind pair remain unsupported. The blind pair is intentionally
ambiguous because its order differs when the small blind is also the heads-up
dealer. Unsupported states continue to use the configured fallback or return a
provider input error when fallback is disabled.

The review UI exposes opponent position only for heads-up postflop states and
clears it when the reviewed hand leaves that scope. External providers receive
the field when it is present.

## Consequences

- Common button-versus-blind and unambiguous ring-seat matchups reach the
  stronger postflop solver without requiring users to translate seats to IP or
  OOP manually.
- Parser confidence and benchmark data can track opponent-position quality.
- The Python routing boundary and Rust plugin duplicate a small deterministic
  resolver, with matching regression coverage, so direct plugin calls remain
  safe.
- Ambiguous seat combinations still require explicit relative-position review.
