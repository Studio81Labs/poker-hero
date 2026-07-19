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
origins. Keep provider URLs and credentials in Coolify secrets.

After deployment, verify:

```bash
curl --fail https://<backend-origin>/api/health
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

The workflow smoke-tests both the SPA and `/api/health`. A frontend success with
an API `502` means the Worker deployed but its configured backend origin is not
healthy or reachable.

## Local Container Validation

```bash
docker compose -f infra/docker/compose.yaml config
docker build -f apps/backend/Dockerfile -t poker-hero-backend:test .
docker build -f apps/frontend/Dockerfile -t poker-hero-frontend:test .
```
