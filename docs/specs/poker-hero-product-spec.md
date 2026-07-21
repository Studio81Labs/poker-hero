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
- Optionally locking the player's own action and sizing before revealing guidance.
- Comparing a locked decision with the recommendation during post-hand review.
- Reviewing aggregate action and exact-line accuracy by street across locked
  answers.
- Filtering recent decisions to a bounded needs-review queue for action or
  sizing differences and reopening the persisted hand.
- Marking a revisited action or sizing difference reviewed without changing the
  historical comparison result.
- Reopening a completed review when it still needs attention.
- Inspecting available decision evidence such as equity, call price, candidate
  action EVs or frequencies, solver quality, and fallback context.
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

- `local_solver_provider`: calls the configured local engine plugin or a custom command. The default plugin solves heads-up postflop trees and records use of the bundled range/EV fallback for unsupported spots.
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

## Data Flow

1. User uploads screenshots or captures a frame in the web app.
2. The frontend creates one queue item and backend job per image.
3. The backend runs the configured parser independently for each job.
4. Each parser result includes structured detected state and field confidence.
5. The UI displays the selected screenshot beside editable detected fields.
6. The user corrects and approves the state, or automation approves it when all configured requirements pass.
7. Before revealing guidance, the user may lock their own action and optional sizing as a training answer.
8. The backend normalizes approved state into a canonical Texas Hold'em decision request.
9. The configured recommendation provider returns action, sizing, confidence, explanation, and raw metadata; recognized evidence is shown without making provider-specific metadata mandatory.
10. When a training answer exists, the UI compares it with the recommendation.
11. Completed comparisons contribute to an aggregate progress view with
    street-level results and recent-hand review links.
12. Non-exact comparisons appear in a separate bounded queue so they can be
    reviewed without labeling solver guidance as unquestionable ground truth.
13. The user may mark a revisited difference reviewed, which removes it from the
    pending queue while preserving it in progress history.
14. A completed review may be reopened, returning the unchanged comparison to
    the pending queue.
15. The UI retains completed items in processing until the user clears them into history.
16. An approved hand may be explicitly added to the parser benchmark; inclusion is never implied by automation.

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
are approved and selected as parser ground truth.

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
- Re-approval or a new recommendation clears any completed training-review marker.
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
- A user can track action and exact-line accuracy across reviewed hands and
  reopen recent decisions.
- A user can isolate the newest action or sizing differences and reopen the next
  hand needing review.
- A user can complete that review so it leaves the pending queue without
  changing recorded accuracy.
- A user can reopen a completed review without changing the locked answer or
  recommendation.
- Solver-backed recommendations expose available decision evidence and disclose
  when a configured engine used a fallback.
- Parser/provider failures are visible and retryable.
- Completed work remains reviewable before being cleared into history.
- Approved screenshots can be explicitly benchmarked against the active parser with persisted field-level results.
- Explicitly selected ground truth can be exported with its original screenshots and canonical labels.
- A valid exported dataset can restore the same ground-truth corpus without duplicating exact existing jobs.
- The system can swap parsers and recommendation providers without changing the core UI workflow.
