# Poker Training Analyzer

Local-first post-hand Texas Hold'em training analyzer. Upload one completed-hand screenshot, review and correct the parsed state, approve it, and request a training recommendation from the configured provider.

This project is for study and post-hand review only. It is not live-play automation, covert real-time assistance, or a tool for use while playing.

## Project Layout

- `backend/`: FastAPI API, parser/provider registry, file-backed job storage, and pytest suite.
- `backend/app/main.py`: FastAPI application entrypoint.
- `backend/data/`: default local job/image data location when running from `backend/`.
- `frontend/`: React/Vite client for uploading screenshots, correcting parsed state, and viewing recommendations.
- `.env.example`: root example configuration intended to be copied to `backend/.env`.

## Prerequisites

- Python 3.11+
- Node `^20.19.0 || ^22.13.0 || >=24.0.0`
- npm

## Backend Setup

```bash
cd backend
python3.13 -m venv .venv  # or python3.11+
source .venv/bin/activate
python -m pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --reload --host localhost --port 8000
```

If `python3.13` is not available, use any Python 3.11+ executable. The backend loads `.env` from the backend working directory when the server is started from `backend/`, so the copied `backend/.env` should keep `POKER_DATA_DIR=data`.

## Frontend Setup

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. The frontend defaults to `http://localhost:8000` for API calls; set `VITE_API_BASE_URL` before running Vite to point it somewhere else.

## Docker

The repository includes containers for both deployment shapes:

- `Dockerfile`: FastAPI API for Coolify, a VPS, or a container host using the repository root as build context.
- `backend/Dockerfile`: same backend image, kept for hosts that let you select a Dockerfile path while still using the repository root as build context.
- `frontend/Dockerfile`: optional static frontend image served by Nginx.
- `compose.yaml`: local full-stack smoke test.

Run both locally with Docker Compose:

```bash
docker compose up --build
```

Then open `http://localhost:8080`. The backend is exposed on `http://localhost:8000`, and job/image data is stored in the `poker-data` Docker volume.

To build only the backend:

```bash
docker build -t poker-training-api .
docker run --rm -p 8000:8000 \
  -v poker-training-data:/app/data \
  --env-file deploy/backend.env.example \
  poker-training-api
```

To build the optional frontend container:

```bash
docker build \
  --build-arg VITE_API_BASE_URL=http://localhost:8000 \
  -t poker-training-frontend ./frontend
docker run --rm -p 8080:80 poker-training-frontend
```

## Internet Deployment

Recommended private-test setup:

1. Deploy the frontend on Cloudflare Workers Static Assets.
   - The included GitHub Actions workflow builds `frontend` and deploys it as a testing Worker.
   - Default Worker URL shape: `https://poker.${APP_WORKERS_SUBDOMAIN}.workers.dev`.
   - The Worker proxies `/api/*` to `BACKEND_URL`, so browser uploads stay on the HTTPS frontend origin.
2. Deploy the backend container on Coolify or a VPS.
   - Build context/base directory: repository root.
   - Dockerfile path: `Dockerfile` preferred, or `backend/Dockerfile` if Coolify requires a nested Dockerfile path.
   - Public port: `8000`
   - Persistent volume: `/app/data`
   - Environment variables: use `deploy/backend.env.example` as the starting point.
   - Set `POKER_CORS_ORIGINS` to the exact Workers/custom frontend URL for direct browser fallbacks and local tests.
3. Put Cloudflare Access in front of both the frontend and API hostnames.
   - Start with an email allowlist for the test users.
   - Protecting only the frontend is not enough; protect the API hostname too.

For MVP auth, prefer Cloudflare Access over an in-app password file. It gives user allowlists, login, sessions, and auditability without adding database work. If the app later needs per-user saved history or roles, use a small SQLite database in `/app/data` rather than a plain auth file. A plain file can work for a tiny admin-managed allowlist, but it is not a great place for passwords once the app is on the internet.

### Cloudflare Frontend Workflow

The frontend deploy workflow uses Cloudflare Workers Static Assets through Wrangler:

- Push to `main`: deploys the testing Worker.
- Manual `workflow_dispatch`: deploys the testing Worker.

Required GitHub repository secret:

- `CLOUDFLARE_API_TOKEN`

Required GitHub repository variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `APP_WORKERS_SUBDOMAIN`: for example `studio81`, producing `https://poker.studio81.workers.dev` when using the default Worker name.

Required GitHub repository or `testing` environment variables:

- `BACKEND_URL`: backend origin proxied by the Worker, for example `http://nb2xpjyjfb8slxcvm568fdhp.89.167.80.252.sslip.io`.

Optional GitHub repository or `testing` environment variables:

- `APP_WORKER_NAME`: defaults to `poker`.
- `VITE_API_BASE_URL`: overrides the browser API base URL. Leave unset for the deployed Worker so the frontend calls same-origin `/api/*`.

Optional GitHub repository or `testing` environment secrets for smoke testing through Cloudflare Access:

- `CLOUDFLARE_ACCESS_CLIENT_ID`
- `CLOUDFLARE_ACCESS_CLIENT_SECRET`

The Cloudflare API token must be able to deploy Workers in the configured account.

## Configuration

Backend settings use the `POKER_` environment prefix. Copy `.env.example` to `backend/.env` for local development.

- `POKER_DATA_DIR`: local job/image storage directory. Use `data` in `backend/.env` when running from `backend/`; use `backend/data` only when running from the repo root.
- `POKER_PARSER_PROVIDER`: `mock`, `llm_vision`, or `ocr_cv`. The `ocr_cv` parser currently reads hero cards, board cards, street, pot, current call amount, active player count, and a first effective-stack estimate from calibrated Fortuna/Nations-style table screenshots; hero position still requires manual review.
- `POKER_PARSER_LAYOUT_PROFILE`: parser layout profile. `generic`, `fortuna`, `nations`, and `fortuna_nations` currently use the same calibrated fixed-region parser.
- `POKER_PARSER_AUTO_APPROVE_ENABLED`: set `true` only when parsed field confidences should auto-approve.
- `POKER_PARSER_AUTO_APPROVE_THRESHOLDS`: JSON object of per-field confidence thresholds.
- `POKER_RECOMMENDATION_PROVIDER`: `rule_based`, `mock`, `local_solver`, `external_solver`, or `llm_advice`. `rule_based` is the local MVP training advisor with deterministic equity simulation plus pot-odds and hand-texture heuristics. `local_solver` runs a solver command over stdin/stdout JSON; when no command is configured it uses the bundled local range/EV solver. `mock` remains as a backward-compatible alias for the same rule engine.
- `POKER_EXTERNAL_PARSER_URL`: required by `llm_vision`.
- `POKER_EXTERNAL_PROVIDER_URL`: required by `external_solver`.
- `POKER_LLM_ADVICE_URL`: required by `llm_advice`.
- `POKER_LOCAL_SOLVER_COMMAND`: optional executable command line for `local_solver`; leave blank to use the bundled local range/EV solver, or set a custom command such as `.venv/bin/python -m app.solvers.ev_solver_cli`. It is parsed into argv and run without a shell, so pipes, redirection, and other shell syntax are not supported.
- `POKER_LOCAL_SOLVER_TIMEOUT_SECONDS`: local solver timeout, default `30`.
- `POKER_MAX_UPLOAD_BYTES`: maximum upload size, default `10485760`.
- `POKER_CORS_ORIGINS`: JSON list of allowed origins, for example `["http://localhost:5173"]`.

Uploads are validated with Pillow-backed image verification. PNG, JPEG, GIF, and WEBP files are supported.

### Local Solver Contract

When `POKER_RECOMMENDATION_PROVIDER=local_solver`, the backend starts the configured solver command, writes a `RecommendationRequest` JSON object to stdin, and expects a `RecommendationResult` JSON object on stdout. The bundled fallback command is:

```bash
.venv/bin/python -m app.solvers.ev_solver_cli
```

The bundled EV solver is not a full GTO tree solver. It builds a weighted opponent range, estimates equity with exact single-opponent enumeration when small enough and deterministic Monte Carlo otherwise, then compares EV candidates for fold/check/call/bet/raise sizes. The command is executed without a shell and must exit with code `0`; stderr is surfaced in the API error response when the command fails.

## Tests

```bash
(cd backend && .venv/bin/python -m pytest)
(cd frontend && npm test && npm run build && npm audit)
```

The backend test suite currently passes at 80 tests with one existing Starlette/httpx deprecation warning. The frontend suite currently passes at 7 tests, and `npm audit` reports 0 vulnerabilities after dependency upgrades.

## API Endpoints

- `GET /api/health`: returns service status and active parser/recommendation providers.
- `POST /api/jobs`: uploads one screenshot and returns a parsed job.
- `GET /api/jobs/{job_id}`: returns a stored job.
- `GET /api/jobs/{job_id}/image`: returns the uploaded screenshot image.
- `POST /api/jobs/{job_id}/approve`: saves the reviewed/corrected canonical state.
- `POST /api/jobs/{job_id}/recommend`: requests a training recommendation for an approved state.
