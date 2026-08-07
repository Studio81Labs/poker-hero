# ADR 0031: Protect MCP Principal Administration at the Worker

Status: accepted

## Context

ADR 0018 treated the protected application or Cloudflare Access boundary as
operator authorization for MCP principal management. The deployed Worker must
also support environments where that outer identity layer is absent or does not
cover `/api/*`. In that configuration, ordinary API proxying made principal
listing and token issuance reachable without an operator credential.

The Worker-to-backend secret cannot be entered in the browser: exposing it
would allow callers to bypass the public proxy boundary. Individual MCP agent
tokens are also unsuitable because principal administration must remain a
separate authority.

## Decision

Each deployed Worker receives a high-entropy, environment-specific
`MCP_ADMIN_TOKEN` secret. The Worker requires that bearer token on
`/api/mcp/principals` and every descendant route. It compares SHA-256 digests,
returns non-cacheable `401` responses for invalid credentials, and fails closed
with `503` when the binding is missing or malformed. Deployment and runtime
validation require at least 32 characters without whitespace or control
characters, and deployment rejects reuse of `API_PROXY_SECRET`.

After authorization, the Worker removes the operator `Authorization` header
before proxying. The backend request is authenticated only by the existing
`API_PROXY_SECRET`/`POKER_PROXY_SHARED_SECRET` pair. The frontend stores the
admin token only in component memory after an explicit unlock; it is not
persisted in browser storage or application state outside that control. Admin
requests always use the same-origin Worker and ignore the general API base URL
override so the bearer cannot be sent directly to FastAPI.

The exact `/mcp` route remains distinct: it preserves the agent principal's
bearer token and is explicitly included in Worker Static Assets routing. The
Worker rejects percent-encoded proxied pathnames before classifying the route,
so backend path decoding cannot bypass the administration boundary. Deployment
smoke checks require the administration boundary to return `401` when MCP is
enabled, accept the fail-closed `503` only while MCP is disabled, and verify the
enabled MCP endpoint returns its authentication challenge instead of a Static
Assets method response.

## Consequences

- Credential creation, rotation, revocation, and metadata require a dedicated
  operator secret even when no outer Access policy is present.
- The operator, agent, and Worker-to-backend credentials remain independent and
  can be rotated without expanding one another's authority.
- Operators must retrieve the environment's admin secret before using the
  **Agent access** controls.
- Staging and every MCP-enabled deployment must configure `MCP_ADMIN_TOKEN`;
  runtime administration fails closed when the binding is absent.
- This decision replaces ADR 0018's assumption that an outer protected-app
  boundary alone authorizes principal management.
