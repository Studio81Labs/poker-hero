# Architecture

## System Shape

Poker Hero is a two-app monorepo. The browser control panel never talks to OCR
or recommendation engines directly; the FastAPI backend owns those integrations
and normalizes all results into stable API models.

```text
Browser
  -> React/Vite frontend
  -> same-origin /api proxy (Cloudflare Worker in testing)
  -> FastAPI backend
     -> parser registry -> OCR/CV or external vision service
     -> file-backed job store in POKER_DATA_DIR
     -> parser benchmark -> explicit approved-state corpus and persisted reports
     -> provider registry -> local solver router, rule engine, or external service
        -> preflop chart, postflop-solver plugin, or bundled range/EV fallback
```

## Applications

### Backend

`apps/backend` owns upload validation, parser and provider selection, canonical
state validation, automation-compatible job transitions, recommendation calls,
persisted job/image data, and read-only parser benchmark runs. Integrations are selected by environment-driven
registries so the frontend flow does not depend on a concrete engine.

The `local_solver` provider has a second configurable boundary for local engine
plugins. Supported preflop states use a position-aware 169-hand training chart.
When a reviewed state supplies structured preflop opener position and total
opening size, the chart uses those values for eligibility, matchup-specific
continue/reraise boundaries, opening-size adjustments, and sizing. Older states
retain a conservative free-text fallback. Every resolved total must match the
call amount plus hero's posted blind and remain within the supported 2-4 BB
single-open range. Recommendation evidence records the resolved opener, base and
stack-adjusted opening ranges, base response boundaries, size multipliers, and
adjusted boundaries. Effective stack selects a short (up to 20 BB), medium (up to 50 BB),
standard (up to 150 BB), or deep policy. That policy adjusts first-in ranges and
sizing plus continue/reraise boundaries; its band and multipliers are retained
in the same evidence payload. Capped blind reraises reconstruct a total amount
from stack behind, the hero's posted blind, and hero stack when available; the
resolved effective cap is retained for review.
`postflop_solver` runs as a pinned Rust stdin/stdout process for heads-up
postflop decisions. `local_ev` remains available directly and is used as a
recorded fallback for ambiguous preflop, multiway, incomplete,
resource-limited, or failed postflop solves. Explicit custom commands still
override the bundled engine selection.

### Frontend

`apps/frontend` owns screenshot upload and capture, queue navigation, review and
correction, automation controls, pre-reveal training decisions, recommendations,
decision-evidence presentation, aggregate training progress, and history. It
defensively normalizes optional provider metadata such as equity, candidate
EVs/frequencies, exploitability, preflop stack/range/sizing policy, and fallback
context. Supported postflop results also expose bounded tree/history metadata
and keep exact configured OOP/IP ranges behind a collapsed disclosure; providers
remain free to omit those fields. In production it uses same-origin `/api/*`;
`worker.js` forwards those requests to `BACKEND_URL` and serves all other routes
from Worker Static Assets.

The benchmark dialog lets a user explicitly include the current approved hand
as ground truth, run the active parser across the corpus, and inspect aggregate,
per-field, and per-case results. Case drill-downs compare expected and detected
values; selecting Review hand refetches the persisted job before opening it in
the correction workspace. The overview returns a bounded recent-run summary;
compact field metrics support trend comparisons, while full archived reports
are loaded only when selected.

The explicitly selected benchmark corpus can be exported as a ZIP without
running the parser. `manifest.json` identifies schema version 1, parser/layout
context, and each approved canonical state. Original screenshots are stored at
stable `images/<job-id>.<ext>` paths referenced by the manifest. Unselected jobs,
parser output, recommendations, and player decisions are excluded.

The same archive can be imported to restore or share a corpus. Import validates
the complete manifest, paths, limits, and image payloads before creating jobs.
Stable job IDs make exact re-imports idempotent; an existing job with different
image bytes or approved state rejects the archive instead of being overwritten.
Imported cases are approved benchmark jobs, while recommendation and training
data remain absent. Ground-truth labels are not copied into parser results, so
an imported job never presents user-approved state as detected OCR evidence.
The shared import/export corpus contract is capped at 250 selected hands; the
selection API prevents the app from producing a dataset that import rejects.

## State Flow

1. A capture or upload creates an independent job.
2. The configured parser returns detected state, confidence, warnings, and raw metadata.
3. The user or automation approves a canonical state when requirements are met.
4. The user may lock an action, optional sizing, and optional self-rated
   certainty before revealing provider output.
5. The configured provider returns an educational action, sizing, confidence, and reasoning.
6. The UI compares a locked training decision with the recommendation when one exists.
7. Completed decision/recommendation pairs contribute to the on-demand training progress summary.
8. A non-exact comparison can be marked reviewed with an optional lesson note
   after the user revisits its evidence.
9. A hand opened from the needs-review queue advances to the next hand matching
   the same action, street, and ordering filters after its review is persisted.
10. Completed reviews with notes remain available in a bounded Lessons list,
    filterable by street/text and ordered by recency or available EV loss,
    without returning them to the pending queue. The same complete selection
    can be exported as Markdown.
11. Completed queue items remain in processing until explicitly cleared into
    backend-persisted history. Unarchived upload and capture jobs restore in
    stable queue order after reload.
12. Explicitly selected approved states can be re-parsed as a benchmark corpus without mutating the job flow.

Training decisions are persisted with the job. The API accepts them only for an
approved state that does not yet have a recommendation, preventing a revealed
solver result from being recorded afterward as a supposed pre-reveal answer.
Mutations for one job are serialized. Solver work runs outside that critical
section, then reloads and validates the latest approved state before committing
its result so concurrent decisions and unrelated job metadata are preserved.
Before releasing the lock, recommendation work persists an in-progress marker;
re-approval is rejected while that marker remains, and provider setup or
execution clears it on every terminal success or failure. Backend startup
converts an orphaned marker into a visible retryable error because no provider
operation survives a process restart. A reloaded frontend keeps the processing
cache unsynchronized and polls the projection while that marker remains,
retrying transient projection failures so a solver result committed after the
first reload read is not hidden by the browser cache.
The training progress endpoint derives action and exact-line policy accuracy,
street breakdowns, optional EV-loss grading, equal-window recent trends, and
recent review links from persisted jobs. It also aggregates the recommendation
`raw.engine` value for each compared hand, grouped by canonical street. Each
street with at least two hands derives equal recent and previous performance
windows capped at ten hands per side. Its EV-loss delta requires at least one
gradable hand in both windows. A canonical street selector filters only the
bounded Recent decisions projection and is mutually exclusive with position
and solver selectors.
Approved hero-position labels are normalized into common six-max seats plus
IP/OOP for a separate performance breakdown. Missing positions stay in an
explicit unpositioned count and do not receive a synthetic label. A normalized
position selector, or the explicit unpositioned selector, filters only the
bounded Recent decisions projection. Position and solver selectors are
mutually exclusive, while aggregates and the pending-review projection remain
global. Each normalized position and the unpositioned bucket separately expose
their global unresolved count. A review-position selector, or the explicit
review-unpositioned selector, filters the pending-review projection and
composes with action-pair, street, certainty, and ordering parameters without
changing aggregate or Recent decisions results. Each normalized position with
at least two hands also derives equal recent and previous performance windows
capped at ten hands per side. Its EV loss delta requires at least one gradable
hand in both windows.
Non-empty `fallback_reason` values count as fallback and are grouped for
diagnostics; `routing_reason` records an intentional engine choice, such as the
preflop chart route, and does not count as fallback. Older recommendations
without an engine remain in the total as unattributed hands. Each engine route
and fallback summary includes a SHA-256 key derived from its normalized label.
Attributed engine routes reuse the same mixed-strategy-aware outcome and EV-loss
comparisons as global progress to report action accuracy, exact-line accuracy,
and an average over only the route's EV-gradable hands. Fallback-reason
summaries apply the same comparison contract to their matching hands. Both
summary types also derive equal recent and previous performance windows, capped
at ten hands per side; an EV-loss delta requires graded hands in both windows.
Solver coverage also compares equal recent and previous windows capped at ten
hands each. It reports attribution and fallback rates separately so increased
attribution and decreased fallback use are both presented as improvements.
The progress endpoint accepts one of those fixed-length keys, or an explicit
unattributed selector, to filter only the bounded Recent decisions projection.
This avoids raw provider metadata in query strings while leaving every
aggregate and pending-review projection global. Route, fallback, and
unattributed selectors are mutually exclusive per request. Completed notes
have their own global count and bounded list ordered by review time, independent
from both the recent and pending-review limits. The endpoint also groups rated
decisions by low, medium, or high pre-reveal certainty so accuracy and available
EV loss can be calibrated without excluding legacy or unrated hands from
overall progress. Each rated group with at least two hands derives the same
equal recent and previous performance windows used by the global, street,
position, and solver summaries. Each rated summary also exposes its global
pending-review count so the frontend can open that certainty queue without
deriving counts from the bounded response. Separate unrated total and pending
counts keep legacy decisions discoverable without treating missing self-ratings
as a calibration category or assigning them a trend. The progress endpoint also
accepts a rated or unrated certainty selector for the bounded Recent decisions
projection. That selector is mutually exclusive with street, position, and
solver Recent filters and does not change aggregates or pending-review results.
Trend windows use the newest and
immediately preceding reviewed hands, have the same size, and are capped at ten
hands each. Action and exact-line deltas are available once two reviewed hands
exist. The EV-loss delta is available only when both windows contain at least
one comparable EV grade. Unsupported action choices are also grouped by the
player's action and the headline recommendation, ordered by frequency and then
available average EV loss. Solver-supported mixed actions and same-action
sizing differences are excluded so the summary does not overstate mistakes.
Patterns retain their full hand count while averaging EV over only the hands
with comparable candidate grades, and expose a separate pending-review count.
The review endpoint accepts player-action and headline-action filters only as a
complete pair. That pair selects unsupported action outcomes before optional
street, certainty, and normalized-position filtering, ordering, and limiting,
so solver-supported mixed actions are not pulled into a focused pattern queue.
Normalized position and explicit unpositioned review selectors are mutually
exclusive. The headline recommendation is always supported. Alternate provider
candidates are supported
only when their action/sizing metadata is valid and modeled frequency is at
least 5%, which filters numerical strategy noise. An exact alternate line is
recorded as a supported mix; an alternate action with different sizing remains
reviewable. When candidate metadata also includes finite numeric EV values in
BB, the backend compares the exact locked line with the highest-EV valid
candidate and reports non-negative per-hand and average EV loss. Missing,
implicit, or malformed action/sizing/EV metadata leaves the hand ungraded for EV
without changing its action-policy outcome. A grade also requires the provider's
recommended line and at least one distinct valid alternative, preventing a
partial candidate payload from claiming zero loss. Hands processed only by
automation are excluded because they have no player answer to evaluate. A
separate bounded queue returns unsupported actions and sizing differences so the
frontend can review them without hiding older differences behind supported
lines. It defaults to newest-first order. An explicit EV-loss order ranks
graded hands by descending loss, breaks ties by recency, and keeps ungraded
hands afterward in recent-first order. Ordering happens before the queue limit
so an older costly mistake remains discoverable.
An optional street filter is applied before that ordering and limit. The review
queue can also select low, medium, high, or unrated decisions. Certainty, street,
and complete action-pair filters compose before ordering and limiting. The
response keeps the global pending-review count separate from the number of hands
matching the active filter, so a focused queue does not misrepresent overall
progress.
Pending counts are also returned per street. The frontend uses only streets
with pending work when suggesting a focus: highest average EV loss wins when
comparable EV grades exist, otherwise the lowest action accuracy wins. Pending
volume and canonical street order provide deterministic tie-breakers. Each
street summary also exposes its pending count as a direct shortcut into the
same composed review queue.
The frontend applies the same EV-loss, action-accuracy, pending-volume order to
rated certainty summaries with pending work, using high-to-low certainty as the
final deterministic tie-breaker. The Unrated backlog is suggested only when no
rated certainty group has pending reviews, because it has no calibration
metrics to compare.
Normalized position summaries use the same ranking, with canonical position
order as the final tie-breaker. The Unpositioned backlog is suggested only when
no normalized position has pending reviews, because it has no position-level
accuracy or EV metrics to compare.
Action-difference suggestions consider only patterns with pending work. The
highest comparable average EV loss wins when graded patterns exist; otherwise
the largest unresolved backlog wins. Total pattern volume and canonical action
order make ties deterministic. Pattern rows expose that unresolved count as the
review action; completed patterns render a non-actionable clear state.
Completing a review persists a timestamp and optional normalized lesson note on
the job, then removes it from the pending queue without changing historical
accuracy. The progress projections include the note for later study.
The lesson selector applies street and case-insensitive note-text filters before
ordering by review recency or available EV loss. EV-loss order keeps graded
lessons highest first, uses review time for ties, and places ungraded lessons
afterward in newest-first order. The UI applies its display limit only after
that ordering; Markdown export uses the same selector without the limit.
Re-approval, a changed training decision, or a fresh recommendation clears both
the marker and note because the comparison inputs have changed. Deleting only
the review marker explicitly reopens the same comparison and returns it to the
pending queue while retaining the note for editing.
Both the workspace and training-progress dialog reconcile the affected
processing or history record when a review mutation response is lost, so a
same-tab reload cannot preserve stale review metadata from browser storage.
The frontend treats a hand opened from that queue as a review session. After
persisting its review marker, it reloads the progress endpoint with the current
action-pair, position, street, certainty, and order parameters and opens the
first remaining hand.
An exhausted session returns to the filtered empty queue; a continuation error
does not roll back or misreport the review that already completed.

Batch items are isolated. A parser or recommendation failure affects that item
only and leaves other queue items free to continue.

## Persistence

The backend stores jobs, images, and benchmark reports under `POKER_DATA_DIR`.
The frontend retains automation preferences in versioned browser-local storage;
invalid or unavailable storage falls back to the established application defaults.
Unarchived upload and capture jobs are exposed through a stable oldest-first,
offset-paged processing projection with a snapshot hash. The frontend caches at
most 100 of those records for immediate reload display, retains the complete
persisted count, and reconciles all backend pages once per browser session or
after queue membership changes. Snapshot changes restart the bounded page walk,
while a newer in-memory mutation wins by `updated_at`. Cache writes merge
matching records by `updated_at`, avoid no-op storage writes, and storage events
invalidate sibling tabs so one tab cannot silently replace another tab's newer
record. Invalid or substantially future-dated processing timestamps invalidate
the browser snapshot and force an authoritative reload instead of outranking
terminal server state. Imported benchmark-only jobs have approved labels but no
parser result, recommendation, training decision, review metadata, error, or
active recommendation, so untouched imports remain in the benchmark corpus
without appearing as processing work. Once an imported hand starts
recommendation work, records training state, or receives a retryable error, it
returns to the processing projection until that work is completed.
Archiving sets `archived_at` on the existing job rather than copying its data;
the history projection orders those jobs by archive time and returns a bounded
latest list plus the complete count. Offset-based reads let the frontend append
older pages inside the fixed history rail. The frontend restores the newest
projection once per browser session and retains only that bounded first page in
its local cache for immediate display and compatibility with history saved
before the backend archive contract. Server-confirmed changes to a reopened
archived job update the in-memory history projection and bounded cache through
the same shared job-replacement path; unsaved form edits do not alter history.
Incoming refresh pages reconcile matching jobs by `updated_at`, so an older
in-flight response cannot overwrite a newer saved correction.
Optional all-term history search filters the complete persisted archive before
offset paging. A history-specific lock gives each archive scan and snapshot hash
a consistent view without blocking unrelated active-job updates. Search pages
carry that snapshot version so the frontend appends the next page directly while
the archive is unchanged, and rebuilds the loaded extent in bounded larger
requests only after a version change. Search results and their match count remain
separate from the global archive count and newest-page browser cache.
Local development uses `apps/backend/data`; the container contract uses
`/app/data`. Coolify must mount persistent storage at `/app/data`. The container
entrypoint repairs volume ownership before dropping to the non-root `poker`
user.

## Deployment Topology

- Frontend: Cloudflare Worker Static Assets plus the `/api/*` proxy.
- Backend: Coolify Docker application built from repository root with
  `apps/backend/Dockerfile`.
- Access control: Cloudflare Access can allowlist testing users at the public
  frontend and backend boundaries.

The frontend Worker proxy removes mixed-content and browser CORS issues from the
normal deployed path. Backend CORS remains configurable for local and direct API
testing.
