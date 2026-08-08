# ADR 0032: Derive Cold Four-Bet-Pot Postflop Ranges

## Status

Accepted

## Context

The preflop trainer already models a later player's cold 4-bet after an opener,
a 3-bet, and the opener's fold. Postflop analysis still treated the resulting
heads-up pot as a generic configured-range spot, even when the complete action,
surviving seats, and dead money were reviewed.

## Decision

Extend contextual postflop range selection to the exact four-action line:

1. one 2-4 BB open;
2. one later-seat full 3-bet within the supported ratio bands;
3. one full cold 4-bet by a distinct later seat within the supported ratio
   bands; and
4. one matching call by the original 3-bettor.

Exactly two players must remain, and they must be the original 3-bettor and the
cold 4-bettor. The three actors must follow legal six-max action order, optional
legacy opener fields must agree, and the reconstructed flop-root pot must retain
the folded opener's final opening commitment alongside both surviving players'
matching 4-bet commitments. Missing or contradictory evidence keeps configured
ranges.

The cold 4-bettor uses the existing three-seat cold-response policy's adjusted
4-bet boundary. The original 3-bettor uses the corresponding cold-4-bet defense
policy's adjusted continue band after excluding its 5-bet segment. Both apply
the represented raise-size bands and reconstructed stack-depth policy.

The solver records a distinct `preflop_chart_cold_four_bet_pot` source plus the
actors, sizes, folded-opener commitment, policies, and adjusted boundaries in
recommendation evidence. The Rust plugin accepts that source explicitly, and
the frontend presents its assumptions separately from an ordinary 4-bet pot.

## Consequences

- Supported cold 4-bet pots use ranges tied to their reviewed action instead of
  generic configured ranges.
- Folded-opener dead money remains both visible and mandatory for validation.
- Unsupported seat orders, raise sizes, survivor sets, and inconsistent pots
  continue to use the configured fallback.
