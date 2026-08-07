# ADR 0030: Derive Squeeze-Pot Postflop Ranges

## Status

Accepted

## Context

The preflop trainer already models both sides of a bounded squeeze: a player
who reraises after one opener and one caller, and that original caller's
response after the opener folds. When the caller continued, the postflop solver
previously retained generic configured ranges despite having reviewed action,
survivor, sizing, and dead-money evidence for both remaining players.

Treating this line as an ordinary 3-bet pot would lose the caller adjustment on
the squeezer, use the wrong response policy for the caller, and omit the folded
opener's contribution.

## Decision

Recognize an exact four-action history containing an open, matching cold-call,
full supported squeeze by a third later seat, and matching final call by the
original caller. Require exactly two active players whose reviewed seats are
the caller and squeezer, strict canonical seat order, supported sizing,
consistent optional opener metadata, and a reconstructed flop-root pot
containing the opener's final open plus both survivors' final commitments.

Use the existing adjusted open-defense reraise band for the squeezer, including
the single-caller adjustment. Use the existing three-seat squeeze-response
continue band for the caller after excluding its 4-bet segment. Apply the
supported open-size, squeeze-size, and reconstructed stack-depth policies. The
caller's initial call is historical context, not an additional pot
contribution.

Expose a distinct `preflop_chart_squeeze_pot` range source plus the folded
opener, dead commitment, surviving seats, policy boundaries, sizes, and stack
source. Later-street verification and range conditioning use the same
completed-history requirements as other contextual postflop ranges.

## Consequences

- Exact heads-up squeeze pots no longer start from generic configured ranges.
- The squeezer and caller retain their distinct preflop policy adjustments.
- Hidden survivors, active openers, unmatched calls, unsupported sizes, or
  contradictory root pots retain configured ranges or the existing fallback.
- Multi-caller squeezes and other broader dead-money trees remain separate
  profiles until every surviving range can be derived without guessing.
