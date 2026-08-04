# ADR 0004: Isolate Privacy-Safe Runtime Error Monitoring

Status: accepted

## Context

Uptime probes detect unavailable deployment boundaries, and structured access
logs correlate requests after an operator knows where to look. Neither alerts
on an isolated backend exception or browser render crash. Poker screenshots,
cards, player names, provider output, and training notes must not become error
reporting payloads.

## Decision

Keep error reporting optional and isolate Sentry-specific initialization behind
backend and browser adapters. A blank DSN disables each adapter. Capture only
unhandled failures, while existing handled validation and provider errors keep
their normal retryable API behavior.

Apply an outbound allowlist by stripping request metadata and bodies, user
context, breadcrumbs, arbitrary extras, free-form exception values, and stack
locals. Retain exception type and stack locations plus environment/release.
Backend events also retain the route template, method, and request ID needed to
find the corresponding scrubbed container log. Disable browser replay,
automatic session tracking, client reports, and all performance tracing so the
browser emits exception events only. Initialization and delivery failures are
swallowed at the adapter boundary, leaving optional monitoring disabled without
preventing the application from starting.

Use a native React error boundary for the recovery screen and load the browser
SDK dynamically only when configured. This keeps recovery available without
adding monitoring startup/download work to the default path.

## Consequences

- Operators can alert on runtime failures that do not make the app unavailable.
- Events are intentionally less detailed and require request-ID/log correlation.
- Browser stacks are minified until a separate private source-map upload path is
  configured; source maps are not published with static assets.
- Another reporting provider can replace the adapters without changing API or
  component contracts.
