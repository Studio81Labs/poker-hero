# ADR 0016: Add a Heads-Up Limp-Reraise Response

Status: accepted

## Context

The structured preflop chart can isolate one limper from the big blind and can
respond after hero limps into a later isolation raise. It does not cover the
distinct sequence where an opponent limps, hero isolation-raises, every other
player folds, and the original limper reraises. Treating that line as an
ordinary hero open facing a 3-bet would hide the original limp and overstate the
width of the limp-reraiser's range.

## Decision

Route exactly one opponent 1 BB call, one hero raise to 2-5 BB, and one reraise
by the original limper only when exactly two players remain active. Require the
limper to act before hero, a full final raise no larger than 4x hero's isolation
total, known hero and effective stacks, a current call equal to the difference
between the final two totals, and a pot reconstructed from blinds plus each
player's final commitment. The initial limp is replaced by the limper's final
commitment rather than counted twice. Call-first structured history remains
authoritative over stale legacy opener fields.

Apply an explicit continue/four-bet policy for every legal original-limper and
hero-isolator seat pair. Adjust those boundaries with ordered limp-reraise to
isolation ratio bands and the existing stack-depth policy. Target a four-bet at
the larger of 2.2x the limp-reraise or 0.9x the pot, capped by hero stack plus
the represented isolation total and opponent stack plus the represented
limp-reraise total. Record original-limper, hero-isolation, limp-reraise, ratio,
policy, adjusted range, and cap fields in recommendation evidence.

Decline routing when another player remains active, the limper acts after hero,
hero does not make the isolation raise, anyone other than the original limper
reraises, an amount is outside the bounded policy, or stack and pot state are
incomplete or contradictory. These states retain the configured range/EV
fallback.

## Consequences

- A common isolation-raise response receives deterministic, inspectable
  guidance with a range tighter than ordinary 3-bet defense.
- The UI preserves the limp-reraise actors and totals instead of relabeling the
  hand as an open/3-bet sequence.
- Multiple limpers, multiway returns, later action, and arbitrary preflop trees
  remain outside the bundled chart.
