# Poker Hero

Post-hand Texas Hold'em training analyzer for screenshots from online poker
tables. Poker Hero extracts table state, lets the user verify uncertain fields,
and produces an educational recommendation through a configurable local or
external provider.

The project is for study and post-hand review. It is not live-play automation,
covert real-time assistance, or a tool for taking actions in a poker client.

## Quick Start

Prerequisites: Node 24, pnpm 10+, Python 3.11+, Rust 1.85+, and Docker.

```bash
git clone <repo-url> && cd poker-hero
pnpm bootstrap
```

Then start the two apps in separate terminals:

```bash
pnpm backend:dev
pnpm frontend:dev
```

Open `http://localhost:5173`. The API runs at `http://localhost:8000`.

## Project Structure

```text
poker-hero/
├── apps/
│   ├── backend/             FastAPI API, OCR parsers, solvers, storage, tests
│   └── frontend/            React/Vite UI and Cloudflare Worker proxy
├── infra/
│   └── docker/              Local Compose and deployment env example
├── solver-plugins/
│   └── postflop/            Rust heads-up postflop solver adapter
├── docs/
│   ├── specs/               Canonical product specification and archive
│   ├── reference/           Architecture reference
│   └── process/             Deployment and operational procedures
├── scripts/                 Development automation
└── .github/workflows/       App-scoped CI and deployment pipelines
```

## Commands

| Command | Description |
| --- | --- |
| `pnpm bootstrap` | Install dependencies and build the local postflop solver |
| `pnpm backend:dev` | Start FastAPI with reload on port 8000 |
| `pnpm backend:test` | Run the backend pytest suite |
| `pnpm frontend:dev` | Start Vite on port 5173 |
| `pnpm frontend:test` | Run frontend tests |
| `pnpm frontend:build` | Build the production frontend |
| `pnpm docker:up` | Build and start both apps with Docker Compose |
| `pnpm docker:down` | Stop the Compose stack |

## Configuration

Backend settings use the `POKER_` prefix. `pnpm bootstrap` copies
`apps/backend/.env.example` to `apps/backend/.env` when needed.

The main provider switches are:

- `POKER_PARSER_PROVIDER`: `mock`, `llm_vision`, or `ocr_cv`
- `POKER_PARSER_LAYOUT_PROFILE`: `generic`, `fortuna`, `nations`, or `fortuna_nations`
- `POKER_RECOMMENDATION_PROVIDER`: `rule_based`, `mock`, `local_solver`, `external_solver`, or `llm_advice`
- `POKER_LOCAL_SOLVER_ENGINE`: `postflop_solver` (default) or `local_ev`
- `POKER_DATA_DIR`: file-backed jobs and uploaded screenshots
- `POKER_CORS_ORIGINS`: JSON list of direct browser origins

See [apps/backend/.env.example](./apps/backend/.env.example) for the complete
local contract and [infra/docker/backend.env.example](./infra/docker/backend.env.example)
for container-oriented values.

### Local Solver Engines

With `POKER_RECOMMENDATION_PROVIDER=local_solver`, the default
`postflop_solver` engine runs the pinned Rust Discounted CFR adapter. It accepts
heads-up flop, turn, and river states when `hero_position` identifies `IP`,
`OOP`, or button. Blind labels require explicit IP/OOP review because active
player count does not identify the opponent's seat. Its ranges, bet tree,
iteration target, rake, timeout, and memory ceiling are configurable through
the `POKER_POSTFLOP_SOLVER_*` variables in the example env files.
Facing-bet trees also require the visible hero stack so the adapter can
reconstruct whether hero or the bettor was covered before the wager. The
facing action must be confirmed as a first bet; raised pots use fallback until
the canonical state carries full action history.

`pnpm bootstrap` builds the adapter into
`solver-plugins/postflop/target/release/poker-postflop-solver`; the local backend
commands add that directory to `PATH`. Re-run bootstrap after pulling changes
to the Rust plugin.

Preflop, multiway, incomplete, ambiguous-position, oversized, and failed trees
use `local_ev` when fallback is enabled. Recommendations preserve the requested
engine and fallback reason in `raw` metadata. Set
`POKER_LOCAL_SOLVER_ENGINE=local_ev` to bypass CFR, or select
`external_solver` at the provider boundary for a future licensed service.

## Docker

Run the full local stack:

```bash
pnpm docker:up
```

The frontend is available at `http://localhost:8080`, the backend at
`http://localhost:8000`, and job data is kept in the `poker-data` volume.
The backend image compiles and includes the pinned Rust postflop solver plugin.

Build either image directly from the repository root:

```bash
docker build -f apps/backend/Dockerfile -t poker-hero-backend .
docker build -f apps/frontend/Dockerfile -t poker-hero-frontend .
```

## Deployment

The testing deployment uses two services:

- `apps/frontend` deploys to Cloudflare Workers Static Assets. Its Worker
  proxies same-origin `/api/*` requests to the configured backend.
- `apps/backend` deploys as a Docker service in Coolify with persistent storage
  mounted at `/app/data`.

For Coolify, use repository-root build context and Dockerfile path
`apps/backend/Dockerfile`. Expose port `8000` and mount the persistent volume at
`/app/data`.

The frontend workflow requires the `CLOUDFLARE_API_TOKEN` secret and these
repository or `testing` environment variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `APP_WORKERS_SUBDOMAIN`, for example `studio81`
- `BACKEND_URL`, the backend origin used by the Worker proxy
- `APP_WORKER_NAME`, optional and defaults to `poker`

Leave `VITE_API_BASE_URL` unset for the deployed Worker so browser requests use
same-origin `/api/*`.

See [docs/process/deployment.md](./docs/process/deployment.md) for the complete
deployment checklist and [docs/reference/architecture.md](./docs/reference/architecture.md)
for the runtime topology.

## API

- `GET /api/health`
- `POST /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs/{job_id}/image`
- `POST /api/jobs/{job_id}/approve`
- `POST /api/jobs/{job_id}/recommend`
- `PUT /api/jobs/{job_id}/benchmark`
- `GET /api/benchmarks`
- `POST /api/benchmarks/run`

## Documentation

- [Product specification](./docs/specs/poker-hero-product-spec.md)
- [Architecture](./docs/reference/architecture.md)
- [Deployment](./docs/process/deployment.md)
- [Contributing](./CONTRIBUTING.md)

## License

Private - all rights reserved, except `solver-plugins/postflop`, which links the
AGPL-3.0-or-later `postflop-solver` project and is distributed under that
license.
