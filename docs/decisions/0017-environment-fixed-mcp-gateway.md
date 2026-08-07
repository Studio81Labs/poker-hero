# ADR 0017: Add an Environment-Fixed MCP Gateway

Status: accepted

The local stdio decision remains active. ADR 0018 supersedes only the statement
that a hosted transport is future work.

## Context

Agents need a supported way to inspect Poker Hero staging and production and,
in staging, exercise the post-hand training workflow. Giving agents the private
Worker-to-backend header or generating tools for the complete OpenAPI surface
would mix environment selection with individual calls and expose destructive
backup, import, benchmark, and archive operations. Calling stores or providers
inside an MCP process would also bypass the API's validation, locks, rate
limits, idempotency evidence, and request correlation.

## Decision

Add a Python MCP gateway in the backend package using the stable v1 MCP SDK and
local stdio transport. Run a separate process and client configuration for each
environment. The target environment and API base URL are process settings, not
tool arguments.

Add an explicit `POKER_DEPLOYMENT_ENVIRONMENT` backend setting and health field.
The gateway verifies this field before any data operation and refuses a target
mismatch. Production rejects write enablement and registers read-only tools
only. Staging also defaults to read-only; an operator must explicitly enable
the curated upload, approval, pre-reveal decision, recommendation, and lesson
review tools.

All tools call the existing HTTP API. Screenshot upload resolves a local path
under one configured root and applies a separate byte limit. The gateway can
send Cloudflare Access service headers, a future API bearer token, or a private
proxy credential from a trusted deployment. Credentials remain masked process
configuration and are never returned to the agent.

Administrative application backup, dataset import, benchmark execution, and
bulk history mutations are not MCP tools. API errors are converted into bounded
tool failures carrying environment, status, request ID, and retry delay.

## Consequences

- Agent actions preserve the same evidence and state transitions as the browser.
- Tool discovery itself enforces the production read-only boundary.
- A misconfigured staging/production URL fails closed before job data is read.
- Local stdio avoids prematurely publishing an unauthenticated remote MCP
  service, but every agent host needs its own process configuration.
- Hosted Streamable HTTP is governed separately by ADR 0018.
