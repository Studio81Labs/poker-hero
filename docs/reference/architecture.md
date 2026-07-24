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
10. Completed queue items remain in processing until explicitly cleared into history.
11. Explicitly selected approved states can be re-parsed as a benchmark corpus without mutating the job flow.

Training decisions are persisted with the job. The API accepts them only for an
approved state that does not yet have a recommendation, preventing a revealed
solver result from being recorded afterward as a supposed pre-reveal answer.
Mutations for one job are serialized. Solver work runs outside that critical
section, then reloads and validates the latest approved state before committing
its result so concurrent decisions and unrelated job metadata are preserved.
The training progress endpoint derives action and exact-line policy accuracy,
street breakdowns, optional EV-loss grading, equal-window recent trends, and
recent review links from persisted jobs. It also groups rated decisions by low,
medium, or high pre-reveal certainty so accuracy and available EV loss can be
calibrated without excluding legacy or unrated hands from overall progress.
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
street filtering, ordering, and limiting, so solver-supported mixed actions are
not pulled into a focused pattern queue. The headline recommendation is always
supported. Alternate provider candidates are supported
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
An optional street filter is applied before that ordering and limit. The
response keeps the global pending-review count separate from the number of
hands matching the active filter, so a focused queue does not misrepresent
overall progress.
Pending counts are also returned per street. The frontend uses only streets
with pending work when suggesting a focus: highest average EV loss wins when
comparable EV grades exist, otherwise the lowest action accuracy wins. Pending
volume and canonical street order provide deterministic tie-breakers.
Completing a review persists a timestamp and optional normalized lesson note on
the job, then removes it from the pending queue without changing historical
accuracy. The progress projections include the note for later study.
Re-approval, a changed training decision, or a fresh recommendation clears both
the marker and note because the comparison inputs have changed. Deleting only
the review marker explicitly reopens the same comparison and returns it to the
pending queue while retaining the note for editing.
The frontend treats a hand opened from that queue as a review session. After
persisting its review marker, it reloads the progress endpoint with the current
action-pair, street, and order parameters and opens the first remaining hand.
An exhausted session returns to the filtered empty queue; a continuation error
does not roll back or misreport the review that already completed.

Batch items are isolated. A parser or recommendation failure affects that item
only and leaves other queue items free to continue.

## Persistence

The backend stores jobs, images, and benchmark reports under `POKER_DATA_DIR`. Local development
uses `apps/backend/data`; the container contract uses `/app/data`. Coolify must
mount persistent storage at `/app/data`. The container entrypoint repairs volume
ownership before dropping to the non-root `poker` user.

## Deployment Topology

- Frontend: Cloudflare Worker Static Assets plus the `/api/*` proxy.
- Backend: Coolify Docker application built from repository root with
  `apps/backend/Dockerfile`.
- Access control: Cloudflare Access can allowlist testing users at the public
  frontend and backend boundaries.

The frontend Worker proxy removes mixed-content and browser CORS issues from the
normal deployed path. Backend CORS remains configurable for local and direct API
testing.
