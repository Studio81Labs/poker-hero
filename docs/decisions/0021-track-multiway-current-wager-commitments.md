# ADR 0021: Track Multiway Current-Wager Commitments

Status: accepted

## Context

The bundled range/EV fallback evaluates raises by caller count. The canonical
pot already includes outstanding wagers, but `current_bet` is the amount hero
must call. It may be lower than an opponent's total current-street wager when
hero has already committed chips. A scalar call amount also does not reveal
whether one or several opponents have committed the total wager. Treating the
call amount as the existing opponent wager therefore overstates continuation
pots in blind defense and after an initial bet has already received calls.

## Decision

Add optional canonical fields `opponents_at_current_bet`, `opponent_wager`, and
`opponent_commitment_total`. The first records how many opponents have
committed the same latest current-street wager; the second records that wager's
total size, distinct from the amount hero must call. The third records all
active opponents' current-street commitments when they occupy different wager
levels and structured history cannot identify them. For a multiway state facing
a wager, the bundled range/EV fallback requires the reviewed opponent count.
Heads-up states infer one.

The fallback resolves the total opponent wager from an explicit reviewed value,
ordered current-street action history, the reviewed preflop opening size, or a
simple first-bet state. It requests manual review when none of those sources is
available. Supported preflop chart routes do not require these fallback-only
fields. Custom solver commands and external providers may receive the optional
canonical values without making them mandatory.

Multiway postflop OOP/IP history cannot identify more than one opponent. When a
raise leaves active opponents at different wager levels, the fallback requires
the reviewed aggregate commitment total rather than treating lower wagers as
zero. It derives the aggregate automatically for heads-up spots, first bets,
fields entirely at the latest wager, and complete structured preflop history.

Legacy preflop opening size or text is accepted only when it equals the current
call amount plus hero's posted blind. That proves the state is still facing the
initial open. A later re-raise cannot reuse the initial opening size; without
structured history, its current total wager requires explicit review.

Under the fallback's independent equal-response model, a branch with `k`
callers out of `N` opponents contains an expected `k * committed / N` callers
at each recorded wager level. When structured preflop history represents every
active opponent, the fallback retains each actor's latest total commitment and
sums those values. Otherwise it uses the reviewed latest-wager count and treats
unrepresented opponents as having no current-street wager. Hero's existing
wager is `opponent_wager - current_bet`. Each caller must match hero's resulting
total wager, so the branch pot is reconstructed as:

`pot + hero_size + k * (hero_size + hero_wager) - opponent_commitment_total * k / N`

This weights all recorded active-opponent commitment levels under the same
equal-response approximation used for caller counts.

For a preflop action with no amount to call, the fallback still reconstructs
existing wagers. Hero's posted blind or latest structured action is retained,
Complete active-player history supplies the opponent total directly; otherwise
the remaining pre-action pot forms the aggregate opponent commitment pool. Open
branches therefore subtract the expected posted-blind and limp commitments of
their callers instead of treating every caller as uninvested.

## Consequences

- Multiway continuation pots account for initial bets plus existing callers.
- Blind-defense and raised-pot continuation pots use opponents' total committed
  wager and hero's derived existing wager rather than conflating either with
  hero's remaining call amount.
- Re-raised histories include lower-level active commitments as well as the
  latest wager when reconstructing continuation pots.
- First-in and limp-pot branches retain posted blinds and prior limps even when
  hero has no amount to call.
- The review UI exposes the count for multiway facing-wager states and exposes
  the total wager when raised-action context may require correction.
- Automation may approve such a state, but recommendation waits for this
  manually reviewed context when the fallback route needs it.
- Existing persisted states remain valid because the fields are optional and
  derivable states require no migration.
