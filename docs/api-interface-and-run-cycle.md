# API Interface and Run Cycle

This document explains how clients should interface with this backend, how a run executes end-to-end, and where failures usually happen.

Scope note: this codebase is backend-only. Any UI used for testing is external and should consume `/v1/*` endpoints.

## 1) Service Interface at a Glance

### Public endpoints (no auth header required)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Basic service metadata and endpoint list |
| `GET` | `/v1` | Versioned metadata and endpoint list |
| `GET` | `/v1/health` | Liveness check |
| `GET` | `/v1/capabilities` | Supported actions and environment hints |

### Auth-protected endpoints

All endpoints below require either:

- `X-Agent-Api-Key: <key>`, or
- `Authorization: Bearer <key>`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/runs` | Create run (SSE by default unless `stream=false`) |
| `GET` | `/v1/runs` | List runs |
| `GET` | `/v1/runs/:id` | Get run summary JSON envelope |
| `GET` | `/v1/runs/:id/stream` | SSE stream for one run |
| `GET` | `/v1/runs/:id/events` | Get persisted events |
| `GET` | `/v1/runs/:id/artifacts` | Get run artifacts |
| `POST` | `/v1/runs/:id/cancel` | Cancel queued/running run |
| `GET` | `/v1/runs/:id/rollback` | Fetch rollback manifest |
| `POST` | `/v1/runs/:id/rollback` | Restore snapshot (`confirm=rollback`) |
| `POST` | `/v1/runs/:id/artifacts/register` | Register artifact metadata |
| `GET` | `/v1/workflows/status` | Queue/worker workflow health summary |
| `POST` | `/v1/workflows/kick` | Enqueue runnable queued jobs now |
| `POST` | `/v1/workflows/requeue-stale` | Requeue stale running jobs and enqueue |
| `POST` | `/v1/exec` | Execute a command inside E2B sandbox |
| `POST` | `/v1/sandbox/create` | Create E2B sandbox |
| `POST` | `/v1/sandbox/info` | Fetch sandbox status/ports |
| `POST` | `/v1/sandbox/dev/start` | Start or reuse sandbox dev server |
| `POST` | `/v1/sandbox/dev/stop` | Stop sandbox dev process |
| `GET` | `/v1/download.zip` | Download host workspace zip |
| `GET` | `/v1/sandbox/:id/download.zip` | Download sandbox workspace zip |
| `GET` | `/v1/metrics` | Runs/jobs status counters (JSON envelope) |
| `GET` | `/v1/metrics/prometheus` | Runs/jobs counters (Prometheus-style text) |

Legacy non-versioned paths still exist for backward compatibility.

### Internal endpoints

Worker cron endpoints are private (`worker.kickQueuedRuns`, `worker.requeueStaleRuns`).

## 2) Auth and Secrets Model

Auth resolution order:

1. Encore secret `AgentApiKey`
2. `AGENT_API_KEY` environment variable (fallback)

If request token mismatches expected key: `401 unauthenticated`.

If expected key cannot be resolved: invalid-argument error (`AGENT_API_KEY must be set...`).

Important deployment behavior:

- The code declares `secret('AgentApiKey')`.
- In Encore cloud deploys, declared secrets must exist, even if runtime env has `AGENT_API_KEY`.
- Missing `AgentApiKey` causes infra/deploy failure before runtime.

## 3) Data Model Used by the API

Core SQL tables:

- `runs`: primary run state (`queued|running|completed|error|cancelled`) and final output/meta.
- `events`: append-only event stream per run (`status|token|tool|done|error`).
- `jobs`: worker execution/retry state.
- `artifacts`: artifact metadata by run.

Run creation writes:

1. `runs` row with `status='queued'`
2. first `events` row `{status:'queued'}`
3. `jobs` row with `status='queued'` and `max_attempts`

## 4) Full Run Cycle (End-to-End)

### Step A: Client creates run

`POST /v1/runs` body:

```json
{
  "prompt": "your task",
  "input": {},
  "provider": "openai|anthropic|xai|zai",
  "model": "optional-model-name",
  "workspaceBackend": "host|e2b",
  "stream": true
}
```

Behavior:

- `stream` defaults to `true`.
- If `stream=true`, the same POST response is an SSE stream.
- If `stream=false`, response is immediate envelope:
  `{"ok":true,"data":{"id":"...","status":"queued"},"meta":{"apiVersion":"v1","ts":"..."}}`.

### Step B: Worker picks queued job

Flow:

1. Pub/Sub topic `run-requested` receives run id.
2. Worker claims run/job atomically.
3. Worker sets run status `running`.
4. Worker emits `status: running`.

Manual recovery/operations APIs:

- `POST /v1/workflows/kick` to force-enqueue runnable queued jobs
- `POST /v1/workflows/requeue-stale` to recover stale running jobs
- `GET /v1/workflows/status` for queue health (runnable queued/stale running + run/job counts)

### Step C: Agent executes two phases

`runAgent` emits statuses in this order:

1. `phase_started` (`phase=plan`)
2. `phase_completed` (`phase=plan`)
3. `plan_ready` (summary + todos)
4. `phase_transition` (`plan -> build`)
5. `phase_started` (`phase=build`)
6. `phase_completed` (`phase=build`)

Possible additional statuses during run:

- `sandbox_created` (E2B mode)
- `plan_policy_warning`
- `auto_lint_started`
- `auto_lint_fix_attempt`
- `auto_lint_passed` or `auto_lint_failed`
- `rollback_snapshot` (host mode)
- `sandbox_snapshot` (e2b mode)

Tool and token events are also emitted while running:

- `tool` events with `phase=start|end|error`
- `token` events for streamed model tokens
- phase execution is bounded by internal timeouts (`AGENT_PLAN_PHASE_TIMEOUT_MS`, `AGENT_BUILD_PHASE_TIMEOUT_MS`) to prevent indefinite hangs

### Step D: Worker finalization

On success:

1. emit `status: model_resolved` (provider/model/source)
2. update run as `completed` with output + usage + duration
3. emit `done`
4. set job status `succeeded`
5. optional git event in host mode:
   - `git_commit`, or
   - `git_commit_error`, or
   - `git_commit_skipped`

On error:

- If cancelled/aborted: cancel job and stop.
- Else retry with exponential backoff:
  - emits `attempt_failed` then `retrying`
  - retries until `max_attempts`
- Final failure:
  - mark run `error`
  - emit `error`
  - mark job `failed`

On explicit cancel (`POST /v1/runs/:id/cancel`):

- run set to `cancelled`
- job set to `cancelled`
- event emitted: `status: cancelled`

## 5) SSE Contract (What Clients Should Expect)

SSE stream endpoint:

- `POST /v1/runs` when `stream=true`, or
- `GET /v1/runs/:id/stream`

Each event:

- `event: <status|token|tool|done|error|ping>`
- `id: <event-id>`
- `data: {"id":number,"event":string,"data":unknown,"ts":iso}`

Other stream behavior:

- initial historical events are replayed first
- heartbeat `ping` every 15s
- stream closes when run becomes terminal (`completed|error|cancelled`)

## 6) Non-Run Execution Paths

### Sandbox API (`/v1/exec`, `/v1/sandbox/*`)

- Used for direct E2B operations outside the queued run lifecycle.
- Requires `E2B_API_KEY` and `E2B_TEMPLATE`.
- Has retry wrappers for transient E2B/network failures.
- Command execution uses a hard wall-clock timeout wrapper, so stuck SDK calls fail fast instead of hanging indefinitely.

### Download API

- `/v1/download.zip` exports host workspace.
- `/v1/sandbox/:id/download.zip` exports sandbox workspace.
- Sensitive files are intentionally excluded (`.env`, key/cert/private credential formats).

### Metrics API

`GET /v1/metrics` returns envelope data with runs/jobs counters.

`GET /v1/metrics/prometheus` returns:

- `runs_status{status="..."} <count>`
- `jobs_status{status="..."} <count>`

## 7) Why It Can Feel "Not 100%" (Most Common Failure Points)

1. Secret config mismatch:
- deploy fails if `AgentApiKey` secret is missing.

2. Auth key mismatch:
- protected endpoints return `401`.

3. Streaming expectation mismatch:
- `GET /v1/runs/:id` returns summary JSON, not SSE.
- SSE is `GET /v1/runs/:id/stream` (or `POST /v1/runs` with `stream=true`).

4. E2B not configured:
- `/v1/exec` and `/v1/sandbox/*` fail if `E2B_API_KEY` or `E2B_TEMPLATE` missing.

5. Sandbox lifecycle mismatch:
- if a sandbox is paused/evicted, follow-up calls can fail with internal errors such as `Paused sandbox <id> not found`.
- with hard command timeouts enabled, these cases should fail explicitly instead of leaving runs stuck forever.

6. Provider key/model issues:
- run enters `error` with provider/network/model-specific failure text.

7. Retry queue behavior misunderstood:
- failed attempts may stay non-terminal for backoff period; inspect `events` and `jobs` state.

8. Mixed response shapes:
- v1 JSON endpoints return `{ok,data,meta}` envelopes.
- Legacy endpoints return raw JSON objects/arrays.
- Clients should standardize on `/v1/*` to avoid ambiguity.

## 8) Minimal Smoke Test (Recommended)

Assume:

- `API=http://localhost:4000`
- `KEY=<agent-api-key>`

```bash
# 1) Public checks
curl -s "$API/v1/health" | jq '.data.status,.meta.apiVersion'
curl -s "$API/v1/capabilities" | jq '.data.name,.data.actions[0]'

# 2) Auth check (should fail without key)
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/runs"

# 3) Create run without SSE (polling mode)
RUN_ID=$(curl -s -X POST "$API/v1/runs" \
  -H "X-Agent-Api-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Create a tiny change and summarize it.","stream":false}' | jq -r '.data.id')
echo "$RUN_ID"

# 4) Poll status/events
curl -s -H "X-Agent-Api-Key: $KEY" "$API/v1/runs/$RUN_ID" | jq '.data.status,.data.provider,.data.model'
curl -s -H "X-Agent-Api-Key: $KEY" "$API/v1/runs/$RUN_ID/events" | jq '.data[-5:]'

# 5) Optional SSE stream
curl -N -H "X-Agent-Api-Key: $KEY" "$API/v1/runs/$RUN_ID/stream"

# 6) E2B timeout probe (should return quickly, not hang)
SID=$(curl -s -X POST "$API/v1/sandbox/create" -H "X-Agent-Api-Key: $KEY" -H "Content-Type: application/json" -d '{}' | jq -r '.data.sandboxId')
curl -s -X POST "$API/v1/exec" \
  -H "X-Agent-Api-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"sandboxId\":\"$SID\",\"cmd\":\"sleep 120\",\"timeoutMs\":5000}" | jq '.data'

# 7) Workflow control-plane status
curl -s -H "X-Agent-Api-Key: $KEY" "$API/v1/workflows/status" | jq '.data.queue,.data.counts.jobs'
```

Healthy run expectations:

- terminal status in `v1/runs/:id` is `completed`
- `events` contains `phase_started`, `plan_ready`, `phase_transition`, `phase_completed`, `done`

## 9) CLI Checks

Project-level verification commands:

```bash
# smoke (health/capabilities + create/poll one run)
bun run api:check:smoke

# deep (includes event/artifact assertions)
bun run api:check:deep
```

Environment variables for deployed checks:

- `API_BASE=https://<env>.encr.app`
- `AGENT_API_KEY=<key>`
- optional: `CHECK_WORKSPACE_BACKEND=e2b|host`, `CHECK_PROVIDER`, `CHECK_MODEL`

## 10) Release Checklist

Before shipping endpoint/lifecycle changes:

1. `encore check`
2. `bun run typecheck`
3. `bun test`
4. `bun run api:check:smoke`
5. `bun run api:check:deep` (prefer on staging with real secrets)
6. Confirm clients still target `/v1/*` (legacy paths are compatibility-only)
