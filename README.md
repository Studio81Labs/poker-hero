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

## Configuration

Backend settings use the `POKER_` environment prefix. Copy `.env.example` to `backend/.env` for local development.

- `POKER_DATA_DIR`: local job/image storage directory. Use `data` in `backend/.env` when running from `backend/`; use `backend/data` only when running from the repo root.
- `POKER_PARSER_PROVIDER`: `mock`, `llm_vision`, or `ocr_cv`. The `ocr_cv` option is currently a placeholder/unimplemented adapter and raises a configuration error.
- `POKER_PARSER_LAYOUT_PROFILE`: parser layout profile, currently `generic`.
- `POKER_PARSER_AUTO_APPROVE_ENABLED`: set `true` only when parsed field confidences should auto-approve.
- `POKER_PARSER_AUTO_APPROVE_THRESHOLDS`: JSON object of per-field confidence thresholds.
- `POKER_RECOMMENDATION_PROVIDER`: `mock`, `local_solver`, `external_solver`, or `llm_advice`.
- `POKER_EXTERNAL_PARSER_URL`: required by `llm_vision`.
- `POKER_EXTERNAL_PROVIDER_URL`: required by `external_solver`.
- `POKER_LLM_ADVICE_URL`: required by `llm_advice`.
- `POKER_LOCAL_SOLVER_COMMAND`: executable command line required by `local_solver`; it is parsed into argv and run without a shell, so pipes, redirection, and other shell syntax are not supported.
- `POKER_LOCAL_SOLVER_TIMEOUT_SECONDS`: local solver timeout, default `30`.
- `POKER_MAX_UPLOAD_BYTES`: maximum upload size, default `10485760`.
- `POKER_CORS_ORIGINS`: JSON list of allowed origins, for example `["http://localhost:5173"]`.

Uploads are validated with Pillow-backed image verification. PNG, JPEG, GIF, and WEBP files are supported.

## Tests

```bash
(cd backend && .venv/bin/python -m pytest)
(cd frontend && npm test && npm run build && npm audit)
```

The backend test suite currently passes at 67 tests with one existing Starlette/httpx deprecation warning. The frontend suite currently passes at 6 tests, and `npm audit` reports 0 vulnerabilities after dependency upgrades.

## API Endpoints

- `GET /api/health`: returns service status and active parser/recommendation providers.
- `POST /api/jobs`: uploads one screenshot and returns a parsed job.
- `GET /api/jobs/{job_id}`: returns a stored job.
- `GET /api/jobs/{job_id}/image`: returns the uploaded screenshot image.
- `POST /api/jobs/{job_id}/approve`: saves the reviewed/corrected canonical state.
- `POST /api/jobs/{job_id}/recommend`: requests a training recommendation for an approved state.
