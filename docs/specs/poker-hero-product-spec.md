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
  low, medium, and high pre-reveal certainty.
- Opening unresolved differences for a rated certainty level directly from its
  calibration row.
- Seeing legacy unrated totals and unresolved reviews without assigning
  calibration accuracy or EV metrics to those hands.
- Reviewing repeated unsupported action choices grouped by the player's action
  and the solver's headline action, with available average EV loss.
- Opening a repeated action-difference pattern as a focused review queue while
  retaining street and EV-loss ordering controls.
- Filtering decisions to a bounded needs-review queue for action or sizing
  differences, focusing it by street and pre-reveal certainty, ordering it by
  recency or available EV loss, and reopening the persisted hand. Legacy hands
  without a certainty rating remain available through an unrated filter.
- Continuing through hands in the active filtered review queue after each
  completed review, then returning to the queue when no matching hands remain.
- Opening a suggested focus street directly from progress when that street
  still has pending reviews.
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
- Moving completed items into an autosaved history.
- Selecting approved hands as parser ground truth and reviewing field-level benchmark results.
- Exporting the explicitly selected screenshots and canonical labels as a portable parser dataset.

### Backend API

The backend API:

- Accepts screenshot uploads.
- Creates one independent analysis job per screenshot.
- Runs the configured parser.
- Stores the original screenshot, parser output, approved/corrected state,
  pre-reveal training decision, and recommendation result.
- Runs the active parser against an explicit ground-truth corpus without changing the original jobs.
- Persists the latest benchmark report with case and field-level accuracy.
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

- `local_solver_provider`: calls the configured local engine plugin or a custom command. The default route uses a position-aware preflop training chart with opener-to-hero, opening-size, and stack-depth-aware boundaries, solves supported heads-up postflop trees, and records use of the bundled range/EV fallback for ambiguous or unsupported spots.
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
- Effective stack, defined as the minimum visible stack behind.
- Number of players/seats.
- Hero position when detectable.
- Preflop opener position and total opening size when facing a raise.
- Street: preflop, flop, turn, or river.
- Whether the current facing action is a bet or raise.
- Any available action context.

Each recommendation provider declares the minimum fields it requires. The
backend validates the approved state against that provider before sending a
request. A facing-bet postflop tree requires both hero's visible stack and the
effective visible stack so the pre-bet effective stack can be reconstructed
without guessing which player is covered. It also requires an explicit action
classification and accepts only a first bet until the canonical state supports
full raise history. If a solver-style provider requires more context than the
screenshot contains, the UI must ask the user to supply or correct those fields
instead of guessing.

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
5. The UI displays the selected screenshot beside editable detected fields.
6. The user corrects and approves the state, or automation approves it when all configured requirements pass.
7. Before revealing guidance, the user may lock their own action, optional
   sizing, and optional low, medium, or high certainty as a training answer.
8. The backend normalizes approved state into a canonical Texas Hold'em decision request.
9. The configured recommendation provider returns action, sizing, confidence, explanation, and raw metadata; recognized evidence is shown without making provider-specific metadata mandatory.
10. When a training answer exists, the UI compares it with the recommendation
    and any meaningful frequency-bearing policy candidates.
11. Completed comparisons contribute to an aggregate progress view with
    street- and normalized position-level results, optional EV-loss grading,
    recent-hand review links, equal-window recent trends capped at ten hands per
    period, and common unsupported action differences. Missing positions remain
    an explicit count. The same comparisons expose actual
    recommendation-engine coverage by street, recorded fallback reasons, and
    equal-window attribution/fallback trends. Attributed routes and fallback
    reasons also expose player action/exact-line accuracy and average EV loss
    where gradable, plus equal recent/previous deltas when enough matching
    hands exist.
    Rated hands also contribute to certainty calibration; unrated hands remain
    in every other aggregate.
12. Selecting a normalized hero position, the unpositioned bucket, an engine
    route, the unattributed legacy bucket, or a fallback reason shows its newest
    matching training hands in the Recent decisions list. Position aliases are
    normalized by the backend; solver requests use one stable metadata key or
    explicit unattributed selector rather than raw provider text. These filters
    do not alter progress metrics or mistake queues.
13. Unsupported actions and supported actions with a sizing difference appear
    in a separate bounded queue ordered by recency by default. The user may
    focus the queue on one street and certainty rating and prioritize the
    highest available EV losses; filters compose before ordering and limiting,
    and ungraded hands remain available after graded ones.
14. Progress may suggest a street that still has pending reviews, preferring
    the highest average EV loss when comparable grades exist and otherwise the
    lowest action accuracy.
15. A common unsupported action pattern may focus the review queue on that
    exact player-action and solver-action pair.
16. The user may mark a revisited difference reviewed with an optional lesson
    note, which removes it from the pending queue while preserving both in
    progress history.
17. When that hand was opened from the review queue, the UI reloads the same
    action-pair, street, certainty, and order filters and opens the next
    matching hand. An exhausted queue returns to its empty review view.
18. A completed review may be reopened, returning the unchanged comparison and
    its editable lesson note to the pending queue.
19. Saved lessons may be filtered by street and note text, then ordered by
    recency or highest available EV loss before the bounded lesson list is
    returned. Ungraded lessons remain available after graded lessons.
20. The active lesson filters and order can produce a complete Markdown
    download without applying the on-screen list limit.
21. The UI retains completed items in processing until the user clears them into history.
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
must not stop the remaining corpus.

The selected corpus can be exported independently of a benchmark run. The ZIP
contains a versioned JSON manifest and original screenshots under stable,
job-based paths. It excludes unselected jobs and recommendation/training data.
The same ZIP can be imported into another installation. The backend validates
the whole archive before writing, preserves stable job IDs, reuses exact matches,
and rejects conflicting existing jobs without overwriting them. Imported cases
are approved and selected as parser ground truth. They do not synthesize parser
results or confidence from canonical labels.
Parser dataset selection, export, and import share a 250-hand corpus limit.

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
- Add integration tests for local and external providers when concrete engines/APIs are configured.

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
- A user can track action and exact-line accuracy across reviewed hands and
  reopen recent decisions, without counting meaningful solver mixes as mistakes.
- A user can see per-hand and average EV loss for decisions that have comparable
  candidate EV metadata without excluding ungraded hands from other statistics.
- A user can compare training performance by normalized hero position without
  treating hands with missing position data as a fabricated seat.
- A user can open recent hands for one normalized position or the unpositioned
  bucket and clear that filter without changing global progress or the pending
  review queue.
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
  solver-supported mixed actions or sizing-only differences as mistakes.
- A user can open pending reviews for one repeated action pattern without
  manually searching the broader queue.
- A user can isolate the newest action or sizing differences and reopen the next
  hand needing review.
- A user can reorder pending reviews by EV loss so the highest-cost comparable
  decisions are reviewed first without hiding ungraded hands.
- A user can focus pending reviews on one street without changing global
  accuracy or hiding the total number of reviews still pending.
- A user can focus pending reviews by low, medium, or high pre-reveal certainty,
  or isolate legacy unrated hands, without changing global progress.
- A user can see unresolved counts for rated certainty levels and open one as a
  focused review queue directly from confidence calibration.
- A user can see and open an unrated review backlog without representing those
  legacy hands as a calibrated certainty level.
- A user can open an actionable suggested focus street from progress without
  manually comparing the street summary and pending queue.
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
- Approved screenshots can be explicitly benchmarked against the active parser with persisted field-level results.
- Explicitly selected ground truth can be exported with its original screenshots and canonical labels.
- A valid exported dataset can restore the same ground-truth corpus without duplicating exact existing jobs.
- The system can swap parsers and recommendation providers without changing the core UI workflow.
