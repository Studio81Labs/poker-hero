# Poker Training Analyzer MVP Design

## Purpose

Build a local-first training tool for understanding Texas Hold'em hands from real online poker screenshots. The app helps users study game situations after the fact by extracting table state, letting the user verify it, and producing a strategy recommendation with reasoning.

The app is explicitly for training, post-hand review, and game understanding. It is not designed for covert real-time assistance, live play automation, or bypassing poker-client rules.

## MVP Scope

The MVP analyzes one uploaded screenshot at a time.

Supported poker format:

- No-Limit Texas Hold'em.
- Screenshots from online poker tables.
- Multiple poker-client layouts through configurable parsers, starting with a generic parser and sample-driven validation.

Out of scope for the MVP:

- Batch/session processing.
- Real-time screen watching.
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

The frontend is a local browser control panel for:

- Uploading one screenshot.
- Viewing the uploaded screenshot.
- Reviewing detected table state.
- Correcting detected fields.
- Approving the final hand state.
- Viewing the recommendation, sizing, confidence, and reasoning.
- Seeing parser/provider errors and retrying when possible.

### Backend API

The backend API:

- Accepts screenshot uploads.
- Creates analysis jobs.
- Runs the configured parser.
- Stores the original screenshot, parser output, approved/corrected state, and recommendation result.
- Exposes endpoints for job status, detected state, manual corrections, approval, and recommendation results.
- Routes recommendation requests to the configured provider.

### Parser Registry

The parser registry loads the active parser from configuration. Parser implementations share one interface and return normalized structured output plus confidence data.

Initial parser types:

- `llm_vision_parser`: early multi-layout parser for rapid iteration.
- `ocr_cv_parser`: deterministic OCR/computer-vision parser interface for future implementation.
- `mock_parser`: predictable parser for tests and UI development.

The system should support multiple layout profiles. A generic parser may attempt the first pass, and profile-specific parser settings can be added as screenshots reveal layout differences.

### Recommendation Registry

The recommendation registry loads the active recommendation provider from configuration. Providers share one interface and receive canonical Texas Hold'em state.

Initial provider types:

- `local_solver_provider`: calls a local engine for private/local testing.
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
- Effective stack or visible stacks.
- Number of players/seats.
- Hero position when detectable.
- Street: preflop, flop, turn, or river.
- Any available action context.

Each recommendation provider declares the minimum fields it requires. The backend validates the approved state against that provider before sending a request. If a solver-style provider requires more context than the screenshot contains, such as exact action history or effective stack, the UI must ask the user to supply or correct those fields instead of guessing.

## Data Flow

1. User uploads one screenshot in the web app.
2. Backend saves it as a new analysis job.
3. Backend runs the configured parser.
4. Parser returns structured detected state plus confidence per field.
5. UI displays the screenshot beside editable detected fields.
6. User corrects and approves the state.
7. If `autoApprove` is enabled later and all required fields pass configured thresholds, backend may skip manual review.
8. Backend normalizes the approved state into a canonical Texas Hold'em decision request.
9. Configured recommendation provider returns action, sizing, confidence, explanation, and raw metadata.
10. UI displays the recommendation and keeps the screenshot, parsed state, approved state, and result together for review.

## Review And Auto-Approve

Manual review is required by default.

The review UI highlights:

- Missing required fields.
- Low-confidence fields.
- Parsed values that are likely ambiguous.

Auto-approve is a configurable future mode. It can approve a parser result only when all required fields meet configured confidence thresholds. When auto-approve is used, the app must still preserve parser confidence, raw responses, and the approved state for auditability.

## Error Handling And Trust

The app treats recognition as uncertain until validated.

Required behavior:

- Parser output includes confidence per field.
- Missing or low-confidence required fields block recommendation until corrected.
- Parser and provider raw responses are stored for debugging.
- Parser or provider failures are recoverable in the UI.
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

Recommendation tests:

- Use the mock provider for stable UI/backend tests.
- Validate provider request/response contracts.
- Add integration tests for local and external providers when concrete engines/APIs are configured.

End-to-end MVP tests:

- Upload screenshot.
- Run configured parser.
- Display detected state and confidence.
- Apply manual corrections.
- Approve hand state.
- Run configured recommendation provider.
- Display action, sizing, confidence, and reasoning.
- Surface parser/provider errors in a recoverable way.

## MVP Success Criteria

The MVP is successful when:

- A user can run the app locally.
- A user can upload one Texas Hold'em screenshot.
- The parser is selected by configuration.
- Parsed fields appear in a review UI with field confidence.
- The user can correct and approve the extracted state.
- The recommendation provider is selected by configuration.
- The app shows a recommended action, optional sizing, confidence, and reasoning.
- Parser/provider failures are visible and retryable.
- The system can later swap parsers and recommendation providers without changing the core UI workflow.
