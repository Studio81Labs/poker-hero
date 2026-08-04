# Poker Hero Product Specification

Status: current source of truth

## Purpose

Build a local-first training tool for understanding Texas Hold'em hands from real online poker screenshots. The app helps users study game situations after the fact by extracting table state, letting the user verify it, and producing a strategy recommendation with reasoning.

The app is explicitly for training, post-hand review, and game understanding. It is not designed for covert real-time assistance, live play automation, or bypassing poker-client rules.

## Current Scope

Poker Hero analyzes independent screenshots from uploads or browser screen
captures. Users may add one image or a batch to a processing queue, review each
result, run configured automation, and explicitly clear completed items into
history.

Supported poker format:

- No-Limit Texas Hold'em.
- Screenshots from online poker tables.
- Multiple poker-client layouts through configurable parser profiles and sample-driven validation.
- Multi-image upload, browser capture, independent queue processing, and saved history.
- Optional automation for approval and recommendation when configured confidence requirements are met.
- Browser-local retention of the automation master state and options.
- A ground-truth parser benchmark built from explicitly selected approved hands.

Out of scope:

- Reading raw HTML or private application state from a shared screen.
- Continuous analysis intended to influence live play.
- Automated actions in a poker client.
- Full account/player tracking.
- Guaranteed solver-perfect strategy.

## Architecture

The app has a local web UI used as a control panel and a backend that handles screenshots, parsing, state normalization, and recommendation-provider calls.

The backend acts as a proxy/orchestrator for configurable services:

- Screenshot parsers.
- Local engines.
- External APIs.
- LLM-based providers.
- Mock providers for development and testing.

The key architectural rule is that parsers and recommendation providers are chosen by configuration, not hardcoded into the user flow. The UI should not need to change when switching from a mock parser to an LLM parser, or from a local solver to an external recommendation provider.

## Components

### Frontend

The frontend is a browser control panel for:

- Uploading one or more screenshots.
- Capturing frames from a user-selected browser tab, window, or screen when the browser supports that choice.
- Tracking independent processing states in a compact queue.
- Viewing the uploaded screenshot.
- Reviewing detected table state.
- Correcting detected fields.
- Approving the final hand state.
- Viewing the recommendation, sizing, confidence, and reasoning.
- Optionally locking the player's own action, sizing, and self-rated certainty
  before revealing guidance.
- Comparing a locked decision with the recommendation during post-hand review.
- Reviewing aggregate action and exact-line policy accuracy by street across
  locked answers, including meaningful mixed-strategy alternatives when the
  provider exposes frequencies.
- Reviewing average EV loss by street and per-hand EV loss when the provider
  exposes a complete numeric candidate line in big blinds.
- Comparing action accuracy, exact-line accuracy, and available EV loss across
  normalized hero positions while keeping missing positions explicit.
- Comparing equal recent and previous windows for action accuracy, exact-line
  accuracy, and available EV-loss movement.
- Inspecting which recommendation engines handled locked-answer comparisons,
  their street coverage, unattributed legacy hands, and recorded fallback
  frequency and reasons, plus player action/exact-line accuracy and available
  average EV loss for each attributed route and fallback reason, with equal
  recent/previous performance deltas when enough matching hands exist.
- Comparing equal recent and previous windows for solver attribution and
  recorded fallback rates.
- Opening the newest training hands for one attributed engine, the unattributed
  legacy bucket, or a recorded fallback reason without changing global progress
  or the action/sizing review queue.
- Comparing action accuracy, exact-line accuracy, and available EV loss across
  low, medium, and high pre-reveal certainty, including equal recent/previous
  performance deltas when enough rated hands exist.
- Opening the newest training hands for one rated certainty level or the
  legacy unrated bucket without changing global progress or review queues.
- Opening unresolved differences for a rated certainty level directly from its
  calibration row.
- Seeing unresolved counts for normalized positions and hands without a
  recorded position, then opening either group as a focused review queue.
- Seeing legacy unrated totals and unresolved reviews without assigning
  calibration accuracy or EV metrics to those hands.
- Reviewing repeated unsupported action choices grouped by the player's action
  and the solver's headline action, with available average EV loss and visible
  unresolved counts.
- Opening a repeated action-difference pattern as a focused review queue while
  retaining street and EV-loss ordering controls.
- Opening a suggested action-difference focus that prefers the highest
  comparable average EV loss and otherwise the largest unresolved backlog.
- Filtering decisions to a bounded needs-review queue for action or sizing
  differences, focusing it by normalized position or the unpositioned bucket,
  street, and pre-reveal certainty, ordering it by recency or available EV
  loss, and reopening the persisted hand. Legacy hands without a certainty
  rating remain available through an unrated filter.
- Continuing through hands in the active filtered review queue after each
  completed review, then returning to the queue when no matching hands remain.
- Seeing unresolved counts for each street and opening that street as a
  focused review queue directly from its summary row.
- Opening a suggested focus street directly from progress when that street
  still has pending reviews.
- Opening a suggested certainty focus that prefers comparable EV loss, then
  action accuracy, and uses Unrated only when no rated backlog remains.
- Opening a suggested position focus that uses the same performance ranking
  and treats Unpositioned as a fallback when no scored position needs review.
- Marking a revisited action or sizing difference reviewed without changing the
  historical comparison result.
- Saving a short lesson note with a completed review and seeing it in progress
  history or when reopening that review.
- Revisiting completed lesson notes in a dedicated newest-first view that is
  independent from the shorter recent-decisions list.
- Editing or removing a completed lesson note without reopening the review or
  returning it to the pending queue.
- Filtering the full saved lesson set by street and case-insensitive note text
  while keeping total and matching counts distinct.
- Ordering the filtered lesson set by recency or highest available EV loss
  before the bounded display limit, while retaining ungraded lessons afterward.
- Downloading the active filtered lesson set as a complete Markdown study
  document in the selected order independently from the bounded on-screen list.
- Reopening a completed review when it still needs attention.
- Inspecting available decision evidence such as equity, call price, candidate
  action EVs or frequencies, solver quality, preflop chart policy context,
  postflop tree and range assumptions, and fallback context.
- Seeing parser/provider errors and retrying when possible.
- Moving completed items into an autosaved history, loading older archived
  hands, and searching the full archive without expanding or replacing the
  browser cache.
- Selecting approved hands as parser ground truth and reviewing field-level benchmark results.
- Exporting the explicitly selected screenshots and canonical labels as a portable parser dataset.
- Exporting and restoring all durable application data as a portable,
  versioned backup without replacing divergent current records.

### Backend API

The backend API:

- Accepts screenshot uploads.
- Creates one independent analysis job per screenshot.
- Runs the configured parser.
- Stores the original screenshot, parser output, approved/corrected state,
  pre-reveal training decision, and recommendation result.
- Runs the active parser against an explicit ground-truth corpus without changing the original jobs.
- Persists the latest benchmark report with case and field-level accuracy.
- Exports complete durable job/image and benchmark-report state and restores
  it through validation-first, conflict-safe merge semantics.
- Derives training progress from completed decision/recommendation pairs without
  scoring automation-only hands.
- Normalizes approved hero-position aliases and aggregates position-level
  action, exact-line, and available EV-loss performance.
- Aggregates recommendation-engine routes and true fallback metadata for those
  training comparisons without treating intentional provider routing as fallback.
- Reuses mixed-strategy-aware outcomes and available EV grades to summarize
  player performance for each attributed engine route and fallback reason.
- Derives equal-window action, exact-line, and available EV-loss trends within
  each attributed engine route and fallback reason.
- Derives equal-window solver attribution and fallback trends, capped at ten
  reviewed hands per period.
- Filters the bounded Recent decisions projection by one stable engine-route
  key, fallback-reason key, or explicit unattributed selector while leaving
  aggregate metrics and pending reviews unchanged.
- Exports the full filtered and ordered completed-lesson set as a portable
  Markdown study document.
- Exposes endpoints for job status, detected state, manual corrections, approval, and recommendation results.
- Routes recommendation requests to the configured provider.

### Parser Registry

The parser registry loads the active parser from configuration. Parser implementations share one interface and return normalized structured output plus confidence data.

Parser types:

- `llm_vision_parser`: external multi-layout parser adapter.
- `ocr_cv_parser`: deterministic OCR/computer-vision parser with configurable layout profiles.
- `mock_parser`: predictable parser for tests and UI development.

The system should support multiple layout profiles. A generic parser may attempt the first pass, and profile-specific parser settings can be added as screenshots reveal layout differences.

### Recommendation Registry

The recommendation registry loads the active recommendation provider from configuration. Providers share one interface and receive canonical Texas Hold'em state.

Provider types:

- `local_solver_provider`: calls the configured local engine plugin or a custom command. The default route uses a position-aware preflop training chart with opener-to-hero, opening-size, and stack-depth-aware boundaries, solves supported heads-up postflop trees with explicit relative position, maps canonical dealer labels to button/IP, and records use of the bundled range/EV fallback for ambiguous or unsupported spots.
- `rule_based_provider`: deterministic equity and hand-texture guidance.
- `external_solver_provider`: calls an external API for public or broader testing.
- `llm_advice_provider`: uses an LLM for reasoning-oriented recommendations.
- `mock_provider`: returns deterministic test recommendations.

### Normalization Layer

The normalization layer converts parser output and user corrections into one canonical Texas Hold'em decision request. This keeps recognition concerns separate from strategy concerns.

Canonical state should include, where available:

- Hero hole cards.
- Community cards.
- Pot size.
- Current bet/call amount.
- Hero's visible stack.
- The heads-up opponent's visible stack when reconstructing a postflop history.
- Effective stack, defined as the minimum visible stack behind.
- Number of players/seats.
- Hero position when detectable.
- Preflop opener position and total opening size when facing a raise.
- Street: preflop, flop, turn, or river.
- Whether the current facing action is a bet or raise.
- Ordered current-street postflop actions, with OOP/IP actor, action type, and
  total amount committed for each bet or raise.
- Any available action context.

Each recommendation provider declares the minimum fields it requires. The
backend validates the approved state against that provider before sending a
request. A facing-bet postflop tree requires both hero's visible stack and the
effective visible stack so the pre-bet effective stack can be reconstructed
without guessing which player is covered. It also requires an explicit action
classification. A raised heads-up decision requires both visible player stacks
and a complete ordered history from the first OOP action on the current street.
The call amount and facing-action classification must agree with that history.
If a solver-style provider requires more context than the screenshot contains,
the UI must ask the user to supply or correct those fields instead of guessing.

For preflop single-open charts, structured opener position and total opening
size take precedence over free-text action context. Existing approved hands may
fall back to conservative action-text parsing. Defense ranges must use the
resolved opener and hero positions instead of a single averaged response range,
then tighten or widen transparently for supported 2-4 BB total opening sizes.
The resolved total must agree with the amount to call plus any hero blind.
Contradictory or unsupported amounts, hidden callers, later aggression, or
implausible pot composition must decline the chart rather than inventing action
history.

Effective stack selects an explicit preflop policy band: short at 20 BB or less,
medium through 50 BB, standard through 150 BB, and deep above 150 BB. Shorter
bands trim speculative first-in and calling ranges, use smaller first-in sizing,
and move more of the continuing range into reraises. The recommendation must
expose the selected band and multipliers as evidence rather than imply solved
frequencies.

## Data Flow

1. User uploads screenshots or captures a frame in the web app.
2. The frontend creates one queue item and backend job per image.
3. The backend runs the configured parser independently for each job.
4. Each parser result includes structured detected state and field confidence.
   Confidence values must be finite numbers between zero and one; boolean or
   string values are malformed and cannot satisfy automation thresholds.
   Detected pot, bet, and stack values must be finite non-negative JSON numbers,
   preflop open size must be a finite positive JSON number, and player count
   must be a positive JSON integer. Boolean and string coercion is invalid.
5. The UI displays the selected screenshot beside editable detected fields.
6. The user corrects and approves the state, or automation approves it when all
   configured requirements pass. Corrected numeric fields follow the same
   finite-number and integer contract as parser output; malformed approval
   requests do not mutate the parsed job.
7. Before revealing guidance, the user may lock their own action, optional
   finite positive numeric sizing, and optional low, medium, or high certainty
   as a training answer. Boolean and string sizing values are invalid.
8. The backend normalizes approved state into a canonical Texas Hold'em decision request.
9. The configured recommendation provider returns action, sizing, confidence, explanation, and raw metadata; recognized evidence is shown without making provider-specific metadata mandatory. Confidence must be a finite number between zero and one; boolean or string values are malformed.
   Headline sizing must be a finite positive number and is accepted only for bet
   and raise recommendations; boolean or string sizing values are malformed,
   remain retryable errors, and are not persisted as advice.
10. When a training answer exists, the UI compares it with the recommendation
    and any meaningful frequency-bearing policy candidates.
11. Completed comparisons contribute to an aggregate progress view with
    street- and normalized position-level results, optional EV-loss grading,
    recent-hand review links, equal-window recent trends capped at ten hands per
    period, and common unsupported action differences. Missing positions remain
    an explicit count. Each street and position with enough hands also exposes
    equal-window action, exact-line, and available EV-loss changes. The same
    comparisons expose actual recommendation-engine coverage by street,
    recorded fallback reasons, and equal-window attribution/fallback trends.
    Attributed routes and fallback reasons also expose player action/exact-line
    accuracy and average EV loss where gradable, plus equal recent/previous
    deltas when enough matching hands exist.
    Rated hands also contribute to certainty calibration and equal-window
    performance trends; unrated hands remain in every other aggregate.
12. Selecting a street, normalized hero position, the unpositioned bucket, a
    rated certainty, the unrated bucket, an engine route, the unattributed
    legacy bucket, or a fallback reason shows its newest matching training hands
    in the Recent decisions list. Position aliases are normalized by the
    backend; solver requests use one stable metadata key or explicit
    unattributed selector rather than raw provider text. Street, position,
    certainty, and solver selectors are mutually exclusive. These filters do
    not alter progress metrics or mistake queues.
13. Unsupported actions and supported actions with a sizing difference appear
    in a separate bounded queue ordered by recency by default. The user may
    focus the queue on one normalized position or the unpositioned bucket, one
    street, and one certainty rating and prioritize the highest available EV
    losses; filters compose before ordering and limiting, and ungraded hands
    remain available after graded ones.
14. Street summaries expose their pending-review counts and may open the
    matching review queue directly. Progress may suggest a street, normalized
    position, and rated certainty group that still have pending reviews,
    preferring the highest average EV loss when comparable grades exist and
    otherwise the lowest action accuracy. The Unrated certainty and
    Unpositioned backlogs are suggested only when no scored group in their
    category has pending work.
15. Progress may suggest a common unsupported action pattern with pending work,
    preferring the highest comparable average EV loss and otherwise the largest
    unresolved backlog. Each pattern exposes its unresolved count; that exact
    player-action and solver-action pair may focus the review queue.
16. The user may mark a revisited difference reviewed with an optional lesson
    note, which removes it from the pending queue while preserving both in
    progress history.
17. When that hand was opened from the review queue, the UI reloads the same
    action-pair, position, street, certainty, and order filters and opens the
    next matching hand. An exhausted queue returns to its empty review view.
18. A completed review may be reopened, returning the unchanged comparison and
    its editable lesson note to the pending queue. Reopen actions from either
    the workspace or progress dialog reconcile persisted state when the response
    is lost.
19. Saved lessons may be filtered by street and note text, then ordered by
    recency or highest available EV loss before the bounded lesson list is
    returned. Ungraded lessons remain available after graded lessons.
20. The active lesson filters and order can produce a complete Markdown
    download without applying the on-screen list limit.
21. The UI retains completed items in processing until the user clears them into
    backend-persisted history. Unarchived upload and capture jobs are restored
    in stable queue order after a reload from a bounded browser cache reconciled
    with the complete paged backend projection. Benchmark-only dataset imports
    do not enter the processing queue. A browser-session restore and explicit
    refresh recover the latest archived hands without relying on one browser's
    local storage, while bounded older pages remain available on demand. Saved
    changes to a reopened archived hand update its visible history entry
    immediately. Archive-wide search uses its own paged result set and match
    count without changing the global reviewed count or newest-page cache.
    Shared processing-cache changes invalidate other open tabs. A persisted
    write that spans a same-tab reload keeps its processing or history
    projection unsynchronized until the leased approval, decision, review, or
    benchmark effect is observed or a bounded recovery lease expires. Unsaved
    corrections to an active hand remain workspace-only when a dataset import
    selects its persisted state as ground truth. Another
    tab's unrelated revision does not settle the lease, and a job omitted from
    processing is revalidated directly before its expected removal is accepted.
    Upload and capture leases wait for every expected new queue item and
    required automation stage; a batch records all selected upload and
    recommendation request identities before its first request. Dataset imports
    record a distinct request identity before upload. After enforcing the
    compressed upload limit, the backend atomically journals the archive before
    parsing or corpus changes, persists validation and archive-decoding failures,
    marks successful receipts complete afterward, and can resume validation or
    partial request-owned cases after an interruption. The frontend recovers
    that exact pending, failed, or completed receipt after a lost response or reload,
    including when every imported hand is benchmark-only and absent from
    processing and history. Observed pending receipts keep recovery alive beyond
    the ordinary lease window, and benchmark operations remain locked until
    import recovery reaches a terminal receipt.
    Deterministic import rejections release their recovery leases immediately.
    A benchmark-only hand with a recorded solver
    attempt remains in processing across reloads so correctable provider
    responses do not hide the workspace. A recommendation
    that first saves the player's decision carries that decision expectation
    until the solver identity is armed, and a superseded provider call cannot
    write over a newer solver identity. A deterministic recommendation conflict
    releases the losing identity and refreshes the competing state; ambiguous
    and correctable attempts retain recovery.
    Batch archive leases cover all target IDs in both projections, so a stale
    first reload cannot leave a hand duplicated in processing or missing from
    history. Unchanged projections after an ambiguous failure do not release
    these leases, and a recovered lease blocks a second mutation from replacing
    it in the same projection.
    Separately, a persisted in-progress
    recommendation keeps revalidating until the backend records its
    recommendation or retryable error, including after transient projection
    failures. Unsafe future-dated cache records force an authoritative reload
    rather than outranking terminal server state, and processing cache records
    require an explicit unarchived marker. Pending benchmark-import
    recommendations remain processing work; re-approval is blocked until active
    work finishes, and backend startup converts orphaned in-progress markers
    into retryable errors. An untouched benchmark-only hand opened for review
    remains visible as workspace-only state during processing refreshes; if it
    later becomes processing work, the queue record replaces it without a
    duplicate.
22. An approved hand may be explicitly added to the parser benchmark; inclusion is never implied by automation.

One item failing at any stage must not stop, discard, or roll back unrelated
queue items.

## Parser Benchmark

Approved states can become reusable parser labels only after the user explicitly
enables `Use current hand as ground truth`. Auto-approval alone must not add a
hand to the benchmark corpus. Re-approving a selected hand updates its expected
state for future runs.

A benchmark run re-parses every selected screenshot with the currently
configured parser and layout profile. It does not overwrite the stored parser
result, approved state, or recommendation. Reports include overall accuracy,
field-level correct/total counts, per-case accuracy, warnings, and isolated
case errors. Case results expose expected and detected values for mismatched
fields and can reopen the persisted hand in the review workspace for correction.
Recent run summaries remain available for parser/layout comparison, with full
historical report details loaded on demand. Comparable runs show overall and
field-level accuracy changes so parser regressions are visible. One failed case
must not stop the remaining corpus. Runs serialize with corpus inclusion,
dataset import, and export so each report observes a complete ground-truth set.
After a restart, corpus operations reject while a durable pending import journal
still requires recovery.

The offline dataset runner can fail on a minimum corpus size, minimum labeled
case count per field, overall accuracy, and individual field accuracy. Field
requirements are repeatable and reject duplicate declarations. Regression runs
should keep separate trusted corpora and thresholds for each supported poker
client/layout, covering cards, street, pot, current bet, stacks, player count,
and position rather than relying on the overall average alone.

The selected corpus can be exported independently of a benchmark run. The ZIP
contains a versioned JSON manifest and original screenshots under stable,
job-based paths. It excludes unselected jobs and recommendation/training data.
The same ZIP can be imported into another installation. The backend validates
the whole archive before writing, preserves stable job IDs, reuses exact matches,
and rejects conflicting existing jobs without overwriting them. Imported cases
are approved and selected as parser ground truth. They do not synthesize parser
results or confidence from canonical labels.
Schema version and declared case count must be JSON integers; boolean, string,
and floating-point coercion is rejected.
Parser dataset selection, export, and import share a 250-hand corpus limit.

## Recommendation Benchmark

A separate offline benchmark evaluates the configured recommendation provider
against canonical hand states and trusted strategy references stored in a
versioned JSON corpus. It does not use screenshots, mutate jobs, or treat the
active provider's own output as ground truth. Each case defines a complete
reference policy whose frequencies sum to one, optional unambiguous bet or
raise sizes, and either complete per-line EV labels or no EV labels.

The report isolates failed cases and measures supported-action agreement,
exact sizing-line agreement where sizing is labeled, mixed-policy distance
when provider candidate frequencies are complete, reference EV loss when the
selected line has a trusted EV, and recorded fallback use. It records line,
policy, and EV evaluation coverage and groups the same metrics by street and
optional scenario tags. The corpus may identify its independent reference
source, version, and configuration. Human-readable and JSON output support
optional regression thresholds for every aggregate and can require source
provenance. The same provider registry and canonical request contract used by
the application must be used by the benchmark.

## Application Backup And Restore

The full application backup is distinct from the parser dataset. It contains
all persisted jobs and source screenshots, including parser output, approved
state, training decisions, completed reviews and lesson notes,
recommendations, history timestamps, and benchmark selection, plus every
persisted benchmark report. It does not contain provider credentials,
environment configuration, or transient import journals.

The ZIP uses a versioned manifest with stable job/report paths, byte sizes, and
SHA-256 checksums. Schema version, entry counts, and image byte sizes must be
JSON integers without boolean, string, or floating-point coercion. Export
refuses to snapshot active parser or recommendation operations. Restore
validates the complete archive, model schemas, image
payloads, path safety, report-to-job references, configured size limits, and
checksums before writing. Missing records are created with their stable IDs;
existing records are reused only when both structured data and source image
match exactly. Any divergent job or report rejects the operation without
overwriting current data. Repeating a completed restore is idempotent.
The deployment tooling can create timestamped copies of the same archive,
validate a stored copy without accessing production records, and run a restore
drill in disposable storage. The drill must verify idempotent re-restore and a
content-equivalent re-export without writing to the configured application data
directory. API mutations must participate in a cross-process data-volume lock;
browser and operational exports must acquire its exclusive side while reading
all persisted records so no partial import or restore can be archived.
An operator must explicitly initialize a durable, versioned data-volume marker
bound to the deployment's configured volume identity after verifying the
production mount. Application startup must not create that marker. Operational
export must require an exact identity match before reading stores, publishing
an archive, or applying retention so a missing or wrong mount cannot be
mistaken for an empty installation. Enrollment success must make the marker's
directory entry durable. Operational export must reject a pending resumable
benchmark import because its journal is not part of the application backup. It
must revalidate the marker and require all store directories under the snapshot
lock before opening constructors that could recreate missing storage.
Publication and retention for one destination must be serialized across
processes. Concurrent scheduled exports must leave a valid retained archive and
must not both report success after deleting each other's output. Success must
fsync the published archive, any newly created destination parent entries, and
the destination directory, including directory metadata changed by retention.
Restored benchmark reports require strict JSON booleans, non-negative integer
counters, and finite numeric accuracy/confidence values; coercion from strings,
booleans, or floating-point counters is rejected before writing. Report, case,
and field totals, statuses, and accuracy ratios must agree with their nested
comparisons, with unique case and field identities. Comparison fields must be
recognized by the benchmark schema, and match flags must agree with the stored
expected and detected values. Both values must match the canonical shape for
their field; hero and board cards must remain jointly unique, text must retain
its normalized representation, and numeric comparison evidence must be finite
and representable by the benchmark matcher.

## Deployment Monitoring

The private testing deployment must have a scheduled end-to-end probe that
checks the frontend application marker, proxied backend health, and one bounded
protected API read. Checks use bounded responses, timeouts, and retries. When
Cloudflare Access service credentials are configured, they must never be sent
across an origin boundary. Repeated failures reuse one open incident rather than
creating notification noise, and a later successful probe closes the incident
with recovery evidence. The monitor may optionally assign the incident to a
configured repository user.

## Review And Auto-Approve

Manual review is required by default.

The review UI highlights:

- Missing required fields.
- Low-confidence fields.
- Parsed values that are likely ambiguous.

Auto-approve is configurable. It can approve a parser result only when all
required fields meet configured confidence thresholds. Auto-request can then
request a recommendation for approved state. Parser warnings may block or be
allowed by configuration. Automation must preserve parser confidence, raw
responses, warnings, and approved state for auditability.

## Error Handling And Trust

The app treats recognition as uncertain until validated.

Required behavior:

- Parser output includes confidence per field.
- Missing or low-confidence required fields block recommendation until corrected.
- Parser and provider raw responses are stored for debugging.
- A training answer cannot be added or changed after recommendation output is revealed.
- Self-rated certainty is captured before reveal and never changes provider
  routing, recommendation output, or whether the hand counts in overall progress.
- Re-approval, a changed training answer, or a new recommendation clears any
  completed training-review marker and lesson note.
- Parser or provider failures are recoverable in the UI.
- Batch failures are isolated and surfaced on the affected queue items.
- Clearing reviewed work archives successful items while error-state items
  remain in processing for retry.
- Users can retry with the currently configured backend.
- The app clearly frames recommendations as training analysis, not guaranteed optimal play.

## Configuration

Configuration controls the active parser and recommendation provider.

Example configuration concepts:

- `parser.provider`: `mock`, `llm_vision`, or `ocr_cv`.
- `parser.layoutProfile`: generic or a named poker-client layout profile.
- `parser.autoApprove.enabled`: boolean.
- `parser.autoApprove.thresholds`: required confidence thresholds per field.
- `recommendation.provider`: `mock`, `local_solver`, `external_solver`, or `llm_advice`.
- `recommendation.localEngine`: `postflop_solver` or `local_ev`.
- Provider-specific settings such as local engine path, API base URL, model name, and credentials.
- Provider capability settings such as required canonical fields and whether partial-state advice is allowed.
- Independent optional bearer tokens for external vision, solver, and LLM
  providers plus a configurable positive request timeout. Authenticated
  provider URLs must use HTTPS, and credentials must never enter frontend state.
- An optional deployment-only Worker-to-backend shared secret. The browser must
  never receive or forward this credential itself.

Configuration must allow local/private testing with local services and later public testing with external services without changing the frontend flow.

## Testing Strategy

Recognition and recommendation plumbing should be tested separately.

Recognition tests:

- Use sample screenshot fixtures.
- Store expected extracted state for each screenshot.
- Start with 5-10 screenshots per target poker-client layout.
- Measure field-level accuracy, not only whole-screenshot success.
- Verify that benchmark runs preserve original jobs and continue after individual parser failures.
- Verify dataset export/import round trips, idempotent re-imports, archive limits, and conflict rejection.

Recommendation tests:

- Use the mock provider for stable UI/backend tests.
- Validate provider request/response contracts.
- Run versioned trusted-reference corpora without changing configured data,
  isolate provider failures per case, and enforce action, sizing-line, policy,
  EV-loss, and fallback regression thresholds independently.
- Treat an alternate candidate as policy-supported only when it has valid action,
  sizing, and frequency metadata and at least 5% modeled frequency.
- Derive EV loss only when the locked line and a best candidate both have valid
  action, explicit sizing, and finite numeric EV metadata expressed in BB. The
  candidate set must include the recommended line and at least one distinct
  alternative.
- Verify lesson exports use the same street/text selection and recency/EV-loss
  order as the Lessons view, include every matching note, and reject an empty
  study set clearly.
- Verify common six-max and IP/OOP position aliases are grouped consistently,
  unknown approved labels remain visible, and missing positions remain separate.
- Verify engine coverage counts valid recommendation metadata, retains
  unattributed legacy hands, and counts `fallback_reason` but not intentional
  `routing_reason` metadata as fallback.
- Verify each attributed route and fallback reason applies the same
  mixed-strategy outcome semantics and averages EV loss over only its gradable
  hands.
- Verify route and fallback performance trends compare equal recorded-time
  windows and omit EV-loss deltas unless both windows contain gradable hands.
- Verify solver coverage trends compare equally sized recent and previous
  windows and treat higher attribution and lower fallback rates as improvements.
- Verify engine-route keys, fallback-reason keys, and the unattributed selector
  are mutually exclusive and filter only the bounded Recent decisions
  projection while preserving global aggregates.
- Exercise the local subprocess engine and external HTTP adapter through the
  complete recommendation API and persisted job flow, independently of their
  focused provider-unit tests.

End-to-end tests:

- Upload one screenshot and a multi-image batch.
- Run configured parser.
- Display detected state and confidence.
- Apply manual corrections.
- Approve hand state.
- Run configured recommendation provider.
- Display action, sizing, confidence, and reasoning.
- Surface parser/provider errors in a recoverable way.
- Continue processing unaffected queue items after one item fails.
- Clear completed processing items into history.

The Playwright browser suite runs the real Vite app against an isolated
FastAPI process with deterministic local HTTP parser and recommendation
providers. It covers repeated automated captures from one live window share
through persisted history, rejection and recovery of a mismatched share-source
selection, retry after cancelling the browser share picker, the complete
single-upload manual review flow, and a mixed valid/invalid automated batch,
including correction persistence,
recommendation display, failure isolation, moving completed work into history,
continuing automated work after a persisted provider failure, persisted parser
failure reconciliation and same-file re-upload, and retrying a recommendation
after its failed provider request has reconciled with persisted backend state.
It also verifies that an in-flight recommendation survives a browser reload and
is reconciled after its original request is lost, that a pre-reveal training
answer and lesson note can be completed, archived, reopened from persisted
progress, and reviewed again without changing the answer or recommendation,
that saved lesson notes can be narrowed by street and text and exported as the
same filtered Markdown study set, that an approved hand can run through the
parser benchmark and an idempotent dataset export/import round trip, and that a
full application backup downloaded from the information dialog can be uploaded
again and verified idempotently without disturbing the current processing
queue. The suite also proves that a hand older than the compact history cache
can be found and reopened through persisted archive search without replacing
the newest-history strip or disturbing active processing work, and that a
25-result search can append and open its older page without duplicating results.
Archived and unarchived hands are also reconstructed from the backend after all
browser-local and session storage is cleared. Persisted training differences
can be narrowed by street and certainty, then completed in sequence without
losing the active review filters. Persisted solver attribution can also be
inspected by engine route and used to reopen the exact training hand. Recorded
solver fallbacks expose their requested engine and reason, and support the same
persisted drilldown workflow. Candidate EV and equity evidence remains visible
after persistence, grades the player's locked line, and can prioritize the
highest-cost pending review. The highest-cost repeated action difference can
also open its persisted, pattern-scoped queue and retain that scope through
review completion. Position aliases normalize into the same persisted focus,
and the highest-loss normalized position can retain that scope while its queue
is completed. The highest-loss rated certainty group can likewise open and
complete its persisted queue without consuming hands from another certainty.
The highest-loss street can open the same persisted workflow while retaining
its approved board state and leaving other streets pending. Legacy hands with
neither a certainty rating nor a recorded position remain reachable from both
fallback suggestions without fabricating either value.
A modeled alternate line with at least 5% strategy frequency remains a
persisted supported mix and does not enter the unsupported-action review queue.
The 5% support threshold is inclusive; an otherwise valid line immediately
below it remains an unsupported action and enters review.
A frequency-bearing bet or raise without its required valid sizing remains
unsupported and ungraded after persistence.
A valid alternate policy line can remain supported when the provider omits its
recommended line from candidate evidence, but that comparison remains ungraded
for EV loss.
A valid alternate policy line with missing or nonnumeric EV metadata likewise
remains supported, but the comparison stays ungraded and does not affect EV
analytics.
A present recommended candidate with nonnumeric EV is treated as unavailable
for grading, just like an omitted recommended candidate.
A non-sized recommended action must still carry explicit `sizing: null`; an
omitted sizing key leaves the comparison ungraded.
A numeric sizing value on a non-sized recommended action is likewise invalid
and leaves an otherwise supported comparison ungraded.
Malformed EV metadata on unrelated candidates does not suppress a comparison
when the locked and recommended lines remain otherwise gradable.
Malformed sizing on unrelated candidates is likewise excluded locally and
cannot become the best-EV line or suppress an otherwise valid comparison.
Unknown actions on unrelated candidates are also ignored without poisoning
otherwise valid policy support or EV evidence.
Candidate frequency is required for policy support but not EV grading; malformed
or missing frequency does not exclude otherwise valid action, sizing, and EV
evidence from the EV comparison.
That rule also applies to the candidate matching the headline recommendation;
its missing or malformed frequency does not suppress otherwise complete EV
evidence.
Conversely, valid action, sizing, and EV metadata cannot grant policy support
when the candidate frequency itself is missing or malformed.
Missing frequency is not inferred from the headline recommendation, EV rank, or
any default strategy weight.
Candidate frequency must also remain within the inclusive 0-100% probability
range; exactly one remains supported, while values above one are unsupported
without invalidating separate EV data.
An exact recommendation match also remains ungraded when candidate evidence
contains no distinct alternative line.
Duplicate entries for the same action and tolerance-equivalent sizing count as
one line for that requirement.
Distinctness is evaluated across the complete candidate set and does not depend
on provider candidate order.
Candidate distinctness must be evaluated in linear time so unbounded provider
metadata cannot stall training progress or the browser comparison.
A same-action sizing difference remains available for review without being
reported as a repeated unsupported-action pattern.
A meaningful alternate action taken at a different size preserves action
accuracy while remaining an exact-line review outside those action patterns.
Sizing drift below 0.01 BB remains an exact persisted match and does not create
review work.
Sizing differences at that boundary remain reviewable after decimal values are
serialized through the frontend and backend.

## Success Criteria

Poker Hero is successful when:

- A user can run the app locally.
- A user can upload or capture Texas Hold'em screenshots and process a batch independently.
- The parser is selected by configuration.
- Parsed fields appear in a review UI with field confidence.
- The user can correct and approve the extracted state.
- The recommendation provider is selected by configuration.
- The app shows a recommended action, optional sizing, confidence, and reasoning.
- A user can optionally record their intended play before reveal and compare it with the recommendation afterward.
- A user can optionally rate how sure they are before reveal and compare
  accuracy and available EV loss across certainty levels without excluding
  unrated hands from overall progress.
- A user can compare recent and previous action, exact-line, and available
  EV-loss results within each rated certainty level that has enough hands.
- A user can track action and exact-line accuracy across reviewed hands and
  reopen recent decisions, without counting meaningful solver mixes as mistakes.
- A user can see per-hand and average EV loss for decisions that have comparable
  candidate EV metadata without excluding ungraded hands from other statistics.
- A user can compare recent and previous action, exact-line, and available
  EV-loss results within each street that has enough reviewed hands.
- A user can open recent hands for one street and clear that filter without
  changing global progress or the pending review queue.
- A user can compare training performance by normalized hero position without
  treating hands with missing position data as a fabricated seat.
- A user can compare recent and previous action, exact-line, and available
  EV-loss results within each position that has enough reviewed hands.
- A user can open recent hands for one normalized position or the unpositioned
  bucket and clear that filter without changing global progress or the pending
  review queue.
- A user can see unresolved counts for each normalized position and the
  unpositioned bucket, then open either as a pending-review queue while keeping
  review street, certainty, action-pair, and ordering controls available.
- A user can compare recent action, exact-line, and available EV-loss results
  against an equally sized preceding period.
- A user can see which engines handled reviewed decisions, their street
  coverage, player action/exact-line accuracy, available average EV loss, and
  where recommendation routing relied on a recorded fallback. The same
  performance details and equal-window changes are available for each fallback
  reason.
- A user can compare recent solver attribution and fallback rates with the
  equally sized preceding period.
- A user can open recent hands for one engine route, the unattributed legacy
  bucket, or a fallback reason and clear that filter without changing the
  pending action/sizing review queue.
- A user can identify repeated unsupported action choices without treating
  solver-supported mixed actions or sizing-only differences as mistakes, and
  can see how many reviews remain for each pattern.
- A user can open pending reviews for one repeated action pattern without
  manually searching the broader queue.
- A user can open an actionable suggested action pattern without manually
  comparing its EV loss and pending volume with every repeated difference.
- A user can isolate the newest action or sizing differences and reopen the next
  hand needing review.
- A user can reorder pending reviews by EV loss so the highest-cost comparable
  decisions are reviewed first without hiding ungraded hands.
- A user can focus pending reviews on one street without changing global
  accuracy or hiding the total number of reviews still pending.
- A user can see unresolved counts for each street and open its pending reviews
  directly from the street summary.
- A user can focus pending reviews by low, medium, or high pre-reveal certainty,
  or isolate legacy unrated hands, without changing global progress.
- A user can see unresolved counts for rated certainty levels and open one as a
  focused review queue directly from confidence calibration.
- A user can inspect the newest hands at one rated certainty level or in the
  unrated bucket without narrowing the unresolved-review queue.
- A user can see and open an unrated review backlog without representing those
  legacy hands as a calibrated certainty level.
- A user can open an actionable suggested focus street from progress without
  manually comparing the street summary and pending queue.
- A user can open an actionable suggested certainty focus without manually
  comparing calibrated groups, while Unrated remains a fallback rather than a
  fabricated performance category.
- A user can open an actionable suggested position focus without manually
  comparing position summaries, while Unpositioned remains a fallback rather
  than a fabricated performance category.
- A user can complete that review so it leaves the pending queue without
  changing recorded accuracy.
- A user can continue to the next hand under the same review filters without
  reopening progress after every completed review.
- A user can reopen a completed review without changing the locked answer or
  recommendation.
- A user can save a short lesson note with a review, find it in progress
  history, and edit it after reopening the unchanged comparison.
- A user can browse completed lesson notes after their hands leave the recent
  decisions window without reopening or re-queuing those reviews.
- A user can correct or remove a completed lesson note while preserving the
  hand's reviewed status.
- A user can prioritize saved lessons by available EV loss without hiding
  ungraded lessons or changing the active street/text selection.
- Solver-backed recommendations expose available decision evidence, including
  preflop chart policy context and postflop tree/range assumptions, and disclose
  when a configured engine used a fallback.
- Parser/provider failures are visible and retryable.
- Completed work remains reviewable before being cleared into history.
- Unarchived processing work survives a browser reload without mixing untouched
  benchmark-only cases into the queue; imported hands with a decision or
  retryable error remain visible as processing work.
- Cleared history survives browser storage resets and can be refreshed from the
  persisted backend.
- A user can search the complete persisted archive and page matching hands
  without replacing the newest-history cache or global reviewed count.
- Approved screenshots can be explicitly benchmarked against the active parser with persisted field-level results.
- Explicitly selected ground truth can be exported with its original screenshots and canonical labels.
- A valid exported dataset can restore the same ground-truth corpus without duplicating exact existing jobs.
- A valid full backup can restore jobs, screenshots, history, training data,
  recommendations, benchmark selection, and reports; exact re-restores are
  idempotent and conflicting records are not overwritten.
- The system can swap parsers and recommendation providers without changing the core UI workflow.
- A deployed backend can reject application API traffic that does not pass
  through the configured frontend Worker while retaining a platform health
  endpoint.
