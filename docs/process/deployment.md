# Deployment

## Backend On Coolify

Configure the application with:

- Branch: `main`
- Build context: repository root
- Dockerfile: `apps/backend/Dockerfile`
- Port: `8000`
- Persistent volume mount: `/app/data`
- Health endpoint: `/api/health`

Start from `infra/docker/backend.env.example`. At minimum, set the parser,
layout, recommendation provider, data directory, upload limit, and allowed
origins. The backend image already contains `poker-postflop-solver`; keep
`POKER_LOCAL_SOLVER_ENGINE=postflop_solver` to use it. The default 768 MB solver
tree limit is separate from container overhead, so allocate at least 1.5 GB RAM
or lower `POKER_POSTFLOP_SOLVER_MAX_MEMORY_MB`. Keep provider URLs and
credentials in Coolify secrets.

For a public Coolify origin, generate a private Worker credential:

```bash
openssl rand -hex 32
```

Set that value as `POKER_PROXY_SHARED_SECRET` in Coolify and as the
`API_PROXY_SECRET` secret in the repository or `testing` environment. The value
must contain at least 32 characters, and `BACKEND_URL` must use HTTPS. When
enabled, the backend accepts application API requests only through a Worker
carrying that secret. The unauthenticated `/api/health` route remains available
for Coolify health checks.

After deployment, verify:

```bash
curl --fail https://<backend-origin>/api/health
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  https://<backend-origin>/api/jobs)" = "401"
curl --fail https://<worker-origin>/api/jobs?limit=1
```

## Frontend On Cloudflare Workers

The `Frontend Deploy` workflow builds `apps/frontend` and deploys the Worker on
push to `main` or manual dispatch.

Required secret:

- `CLOUDFLARE_API_TOKEN`

Required variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `APP_WORKERS_SUBDOMAIN`
- `BACKEND_URL`

Optional variables:

- `APP_WORKER_NAME` (default `poker`)
- `VITE_API_BASE_URL` (leave unset for same-origin production API calls)

Optional Cloudflare Access smoke-test secrets:

- `CLOUDFLARE_ACCESS_CLIENT_ID`
- `CLOUDFLARE_ACCESS_CLIENT_SECRET`

Recommended Worker-to-backend secret:

- `API_PROXY_SECRET`, matching Coolify `POKER_PROXY_SHARED_SECRET`

The workflow smoke-tests both the SPA and `/api/health`. A frontend success with
an API `502` means the Worker deployed but its configured backend origin is not
healthy or reachable. It also reads one bounded processing-queue page so a
mismatched proxy credential fails deployment validation.

## Local Container Validation

```bash
docker compose -f infra/docker/compose.yaml config
docker build -f apps/backend/Dockerfile -t poker-hero-backend:test .
docker build -f apps/frontend/Dockerfile -t poker-hero-frontend:test .
```
