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
        -> postflop-solver plugin or bundled range/EV fallback
```

## Applications

### Backend

`apps/backend` owns upload validation, parser and provider selection, canonical
state validation, automation-compatible job transitions, recommendation calls,
persisted job/image data, and read-only parser benchmark runs. Integrations are selected by environment-driven
registries so the frontend flow does not depend on a concrete engine.

The `local_solver` provider has a second configurable boundary for local engine
plugins. `postflop_solver` runs as a pinned Rust stdin/stdout process for
heads-up postflop decisions. `local_ev` remains available directly and is used
as a recorded fallback for preflop, multiway, incomplete, resource-limited, or
failed postflop solves. Explicit custom commands still override the bundled
engine selection.

### Frontend

`apps/frontend` owns screenshot upload and capture, queue navigation, review and
correction, automation controls, recommendations, and history presentation. In
production it uses same-origin `/api/*`; `worker.js` forwards those requests to
`BACKEND_URL` and serves all other routes from Worker Static Assets.

The benchmark dialog lets a user explicitly include the current approved hand
as ground truth, run the active parser across the corpus, and inspect aggregate,
per-field, and per-case results. Case drill-downs compare expected and detected
values; selecting Review hand refetches the persisted job before opening it in
the correction workspace.

## State Flow

1. A capture or upload creates an independent job.
2. The configured parser returns detected state, confidence, warnings, and raw metadata.
3. The user or automation approves a canonical state when requirements are met.
4. The configured provider returns an educational action, sizing, confidence, and reasoning.
5. Completed queue items remain in processing until explicitly cleared into history.
6. Explicitly selected approved states can be re-parsed as a benchmark corpus without mutating the job flow.

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
