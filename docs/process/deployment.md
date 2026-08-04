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

External OCR, solver, and LLM endpoints can each use an independent bearer
token. Configure the matching `POKER_*_BEARER_TOKEN` value as a Coolify secret
and use an HTTPS endpoint URL. `POKER_EXTERNAL_REQUEST_TIMEOUT_SECONDS` controls
all external HTTP parser and recommendation calls and defaults to 60 seconds.

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

Every backend API response includes an `X-Request-ID`. The backend preserves a
valid caller-supplied ID or generates one, and emits a single-line JSON access
event containing that ID, the method, path, status, and request duration. Use
the ID to correlate a browser or Worker response with Coolify container logs.
Query strings and request bodies are not logged. Successful `/api/health`
probes are logged at debug level to keep routine platform checks quiet. The
event is emitted after the response body completes and identifies interrupted
or failed streams with `"outcome":"failed"`. Each container log line is a
standalone JSON object with its severity in the `level` field, ready for a JSON
log collector without stripping a Uvicorn prefix.
Set `POKER_ACCESS_LOG_LEVEL=DEBUG` when health-probe events are needed during
deployment diagnosis; the default `INFO` threshold suppresses them.

## Runtime Error Monitoring

Error reporting is optional and disabled when its DSN is blank. To enable
backend reporting, configure these Coolify values:

- secret `POKER_SENTRY_DSN`, using a complete HTTPS Sentry DSN;
- `POKER_SENTRY_ENVIRONMENT=testing`;
- optional `POKER_SENTRY_RELEASE`, normally the deployed commit or image tag;
- optional `POKER_SENTRY_ERROR_SAMPLE_RATE`, from zero through one (default one).

Set the public `VITE_SENTRY_DSN` repository or `testing` environment variable
to enable browser reporting. The frontend workflow supplies `testing` as the
environment and the deployed commit SHA as the release. A browser DSN is a
public client key by design; do not place a Sentry API/auth token in any
`VITE_*` value.

Both adapters report unhandled exceptions only. Expected validation, provider
input, and other handled API errors are not incidents. Before transmission,
the adapters remove request bodies, headers, query strings, cookies, user
context, breadcrumbs, arbitrary extras, local variables, and free-form error
messages. Browser session replay and performance tracing are disabled. Events
retain the exception type and stack locations plus release/environment tags;
automatic release-health sessions and client reports are also disabled;
backend events also include the route template, HTTP method, and `X-Request-ID`
for correlation with the JSON container log when that ID is a canonical UUIDv4.
Other caller-supplied request IDs remain local to the response and access log.
Reporting initialization and delivery failures leave the adapter disabled and
never prevent startup or alter the application response.

After configuration, trigger a test exception only in a non-production test
deployment and confirm that the event contains no cards, screenshots, player
names, request payloads, provider output, authorization data, or query values.
Use Sentry project alerts for notification delivery; the GitHub uptime issue
remains the independent availability signal.

## Backup Schedule And Restore Drill

Mount a second persistent or bind-backed volume at `/app/backups` and set
`POKER_BACKUP_DIR=/app/backups`. The entrypoint creates that directory and
grants the non-root `poker` user access. Do not treat `/app/data/backups` or a
second volume on the same host as disaster recovery: copy completed archives
to independent object storage or another host.

Create a stable volume identity and set it as `POKER_DATA_VOLUME_ID` in
Coolify:

```bash
openssl rand -hex 32
```

After the backend is healthy, inspect `/app/data` in the running backend
container and confirm the expected jobs are present. Then enroll that exact
mounted volume once from the running container:

```bash
python -m app.backup_cli init-volume
```

The command atomically writes a versioned `.poker-hero-data-volume` marker bound
to the configured identity. Do not run it from an unverified one-off container.
Scheduled export requires an exact marker match before opening stores,
publishing an archive, or applying retention. A container with a missing or
wrong `/app/data` mount therefore fails closed instead of rotating known-good
backups with an empty archive. Re-running initialization with the same identity
is safe; a different identity is rejected. Export also rechecks the marker and
requires both initialized store directories under the snapshot lock, so partial
volume corruption cannot be silently recreated as an incomplete backup.

Publication and retention hold a destination-wide operating-system file lock.
Overlapping scheduled runs or retries therefore serialize their short publish
phase, and `--retain` cannot let two exporters delete each other's archives.
If the destination filesystem cannot provide the lock, export fails without
publishing or pruning. Successful publication fsyncs the archive and backup
directory; newly created destination entries are fsynced through their existing
parent, and retention fsyncs the directory again after removing old entries.

API mutations hold a shared data-volume lock for their complete request,
including background work. Browser and operational exports take the exclusive
side of that lock while building an archive, so they wait for active mutations
and prevent a partial restore or import from becoming a scheduled backup.

Schedule a daily Coolify task against the backend image or run this inside a
one-off backend container:

```bash
python -m app.backup_cli export /app/backups --retain 14
```

The command prints the absolute archive path on success. It waits for live API
mutations to finish and exits nonzero if persisted active parsing or
recommendation work or a resumable benchmark import still prevents a consistent
export. Configure the scheduler to alert on a nonzero exit and retry later; do
not delete the last known-good off-host archive after a failed run. Retention
only removes older files created with Poker Hero's timestamped backup filename
pattern.

Validate every copied archive at its final storage destination:

```bash
python -m app.backup_cli verify /app/backups/<archive>.zip
```

At least monthly, run the isolated recovery drill:

```bash
python -m app.backup_cli drill /app/backups/<archive>.zip
```

The drill validates the complete manifest, limits, models, images, and
checksums; restores into a temporary directory; repeats the restore to prove
idempotency; and re-exports and compares the recovered data. It never writes to
`POKER_DATA_DIR`. A successful drill reports the restored job and benchmark
report counts. Preserve scheduler logs and the tested archive name as recovery
evidence.

For an actual recovery, deploy a fresh backend data volume, use the information
dialog to restore the tested archive, verify queue/history/benchmark counts,
and only then switch traffic. Never test a recovery by restoring into the live
data directory.

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
mismatched proxy credential fails deployment validation. When
`API_PROXY_SECRET` is configured, the workflow additionally calls the matching
backend queue URL without that credential and requires a `401`, proving the
Coolify setting is active rather than merely accepting an unused Worker header.

## Uptime Monitoring And Alerts

The `Uptime Monitor` workflow runs hourly at minute 17 and can also be dispatched
manually. By default it checks
`https://<APP_WORKER_NAME>.<APP_WORKERS_SUBDOMAIN>.workers.dev`; set the optional
repository or `testing` environment variable `UPTIME_MONITOR_URL` to monitor a
custom HTTPS hostname instead. Manual dispatches use the same admin-controlled
target so Cloudflare Access credentials cannot be redirected to an arbitrary
host.

The hourly interval keeps the private testing monitor within a practical GitHub
Actions budget alongside ordinary CI. Use manual dispatch for an immediate
post-maintenance check.

The probe validates all three deployment boundaries with bounded one-MiB
responses, a 20-second attempt timeout, and three attempts:

- the SPA returns the Poker Training Analyzer application marker;
- same-origin `/api/health` returns JSON with `status: "ok"`;
- same-origin `/api/jobs?limit=1` returns a queue-shaped response, proving the
  Worker proxy and its backend credential are operational.

If Cloudflare Access protects the hostname, configure both
`CLOUDFLARE_ACCESS_CLIENT_ID` and `CLOUDFLARE_ACCESS_CLIENT_SECRET` as repository
or `testing` environment secrets. The probe follows at most five same-origin
redirects and never forwards those service-token headers to another origin.

After all attempts fail, the workflow opens one issue titled
`[uptime] Poker Hero testing is unavailable` with the sanitized failure and run
link. Later failed runs reuse the open incident instead of posting repeated
comments. The first successful run closes every matching open incident with a
recovery link. Set optional `UPTIME_ISSUE_ASSIGNEE` to a valid GitHub login for
direct assignment notifications, and ensure that user has repository issue
notifications enabled. Workflow failures remain visible in Actions even when
no assignee is configured.

Validate the probe locally without contacting the deployment:

```bash
pnpm monitor:test
```

## Local Container Validation

```bash
docker compose -f infra/docker/compose.yaml config
docker build -f apps/backend/Dockerfile -t poker-hero-backend:test .
docker build -f apps/frontend/Dockerfile -t poker-hero-frontend:test .
```
