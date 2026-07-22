# ADR 0001: Isolate The Local Postflop Solver

Status: accepted

## Context

The bundled range/EV engine is fast and handles incomplete, preflop, and
multiway states, but it does not solve a game tree. Private testing needs a
stronger local option without coupling the API or frontend to one solver or its
license.

## Decision

Keep `local_solver` as the recommendation-provider boundary and add a local
engine selector beneath it. The default `postflop_solver` engine is a separate
Rust executable that implements the existing stdin/stdout JSON contract and
pins the AGPL `b-inary/postflop-solver` dependency. `local_ev` remains a
selectable engine and the default fallback.

Only approved heads-up flop, turn, and river states with an explicit IP/OOP
position reach the postflop engine. Facing-bet states also require hero's
visible stack so the adapter can reconstruct whether hero or the bettor was
covered before the wager, plus an explicit classification that the facing
action is a first bet. Raised pots remain on fallback until full action history
is represented in canonical state. The adapter models the current decision
from pot, call amount, position, visible stacks, configured ranges, and a
constrained action tree. It records those assumptions, candidate frequencies,
exploitability, memory estimate, and modeled history in recommendation metadata.

Supported preflop spots route to the position-aware training chart described in
ADR 0002. Other unsupported spots and recoverable solver failures use
`local_ev` only when fallback is enabled. The response records both the
requested engine and the routing or fallback reason.

## Consequences

- Docker builds gain a Rust build stage and a larger build-time dependency set.
- Heads-up postflop recommendations can use Discounted CFR locally.
- Preflop and multiway behavior remains available without pretending to be a
  full tree solve; supported preflop states use the more specific chart route.
- A future licensed solver can replace this executable or provider without a
  frontend workflow change.
- Public distribution or network use requires a fresh review of the AGPL
  obligations and the chosen replacement strategy.
