# Postflop Solver Plugin

This binary adapts the AGPL-licensed
[`postflop-solver`](https://github.com/b-inary/postflop-solver) library to Poker
Hero's stdin/stdout JSON recommendation contract. The dependency is pinned to
revision `9d1509fe5077d019825f833eed04b16d342dfda1`.

It supports heads-up flop, turn, and river decisions with explicit IP/OOP
position or an unambiguous pair of reviewed six-max seats. Canonical `dealer`
positions are equivalent to the button and use the IP route. Contradictory,
duplicate, unknown, and bare small-blind versus big-blind seat pairs are
rejected rather than guessed. A raised decision requires ordered current-street
OOP/IP actions and both visible player stacks. Bet and raise amounts are total
chips committed by that player on the street; contradictory or incomplete
histories are rejected before solving. Poker Hero routes supported preflop
states to its position-aware training chart, and routes ambiguous positions,
ambiguous preflop, multiway postflop, incomplete, and resource-limited spots to
the bundled range/EV engine when fallback is enabled.

The backend defaults to contextual range selection. An exact heads-up
single-raised-pot history with matching reviewed seats uses the preflop chart's
position-specific opener boundary and flat-caller band. The caller band excludes
hands assigned to the chart's reraise segment and follows the chart's existing
open-size adjustment. Other histories retain the
configured OOP/IP ranges, and `POKER_POSTFLOP_SOLVER_RANGE_MODE=configured`
disables contextual selection entirely. The adapter returns the selected range
source and policy context in recommendation evidence.

The plugin and its combined work are distributed under AGPL-3.0-or-later. See
the upstream repository and `Cargo.lock` for dependency details.
