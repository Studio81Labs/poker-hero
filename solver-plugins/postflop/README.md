# Postflop Solver Plugin

This binary adapts the AGPL-licensed
[`postflop-solver`](https://github.com/b-inary/postflop-solver) library to Poker
Hero's stdin/stdout JSON recommendation contract. The dependency is pinned to
revision `9d1509fe5077d019825f833eed04b16d342dfda1`.

It supports heads-up flop, turn, and river decisions. Poker Hero routes
preflop, multiway, incomplete, and resource-limited spots to the bundled
range/EV engine when fallback is enabled.

The plugin and its combined work are distributed under AGPL-3.0-or-later. See
the upstream repository and `Cargo.lock` for dependency details.
