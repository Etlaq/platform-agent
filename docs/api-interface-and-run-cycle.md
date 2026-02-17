# API Interface and Run Cycle

This document defines the simplified public API contract and how the backend owns full run lifecycle internally.

Scope note: this codebase is backend-only. UIs/clients should consume only the public `/v1/*` endpoints below.

## 1) Public API (Stable Contract)

### Public (no auth)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Service metadata |
| `GET` | `/v1` | Versioned metadata |
| `GET` | `/v1/health` | Liveness check |
| `GET` | `/v1/capabilities` | Capability metadata |

### Auth-protected

Auth header:

- `X-Agent-Api-Key: <key>` (or `Authorization: Bearer <key>`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/runs` | Create or idempotently resolve an async run |
| `GET` | `/v1/runs/:id` | Run summary |
| `GET` | `/v1/runs/:id/stream` | SSE stream with replay support |
| `POST` | `/v1/runs/:id/cancel` | Cancel queued/running run |
| `GET` | `/v1/runs/:id/download.zip` | Download run-scoped package |

All other previous workflow/sandbox/metrics/download endpoints are internal-only.

## 2) Run Creation Contract

`POST /v1/runs` body:

```json
{
  "projectId": "default",
  "prompt": "your task",
  "input": {},
  "stream": false,
  "provider": "openai|anthropic|xai|zai",
  "model": "optional-model-name"
}
```

Required:

- `projectId`
- `prompt`
- `Idempotency-Key` request header

Idempotency behavior:

- same `(projectId, Idempotency-Key)` returns the existing run
- duplicate client retries do not create duplicate runs

## 3) Run Summary Shape

`GET /v1/runs/:id` returns envelope data containing:

- lifecycle: `status`, `createdAt`, `startedAt`, `completedAt`, `updatedAt`
- request context: `projectId`, `prompt`, `input`
- result: `output`, `error`
- usage: `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `reasoningOutputTokens`
- cost: `currency`, `estimatedUsd`, `pricingVersion`
- meta: `provider`, `model`, `modelSource`, `usageSource`, `pricingSource`, `attempt`, `maxAttempts`, `sandboxId`, `idempotencyKey`

## 4) Streaming and Reconnect

`GET /v1/runs/:id/stream` is SSE and supports replay via `Last-Event-ID`.

Properties:

- backend replays missed events after the provided event id
- heartbeat `ping` emitted every 15s
- stream closes when run reaches terminal state (`completed|error|cancelled`)
- run execution continues even if client disconnects

## 5) Run Ownership by Backend

Internally, the backend owns:

- queueing and worker claim
- retries/backoff and stale-run requeue
- cancellation propagation
- sandbox lifecycle (create/use/close)
- run metadata persistence
- usage and cost persistence

This means client connection state does not control run execution state.

## 6) Cancel Semantics

`POST /v1/runs/:id/cancel`:

- cancels queued/running runs
- is idempotent for already-cancelled runs
- returns terminal status for already completed/error runs (no mutation)

## 7) Run Download Package

`GET /v1/runs/:id/download.zip` contains run-scoped artifacts:

- `run.json` (summary)
- `events.json` (event log)
- `artifacts.json` (artifact metadata)
- `output.txt` when available
- `error.txt` when available

## 8) Operational Notes

- Encore secret `AgentApiKey` must be set in cloud envs.
- Missing `AgentApiKey` blocks deployment during infrastructure validation.
- Cost estimates are computed from provider response usage metadata only.
- Pricing is resolved from `model_pricing` table entries (active row by provider/model); no hardcoded fallback pricing is used.

## 9) Smoke / Deep Checks

```bash
export API_BASE=https://staging-platform-agent-3p2i.encr.app
export AGENT_API_KEY=<key>
export CHECK_PROJECT_ID=default

bun run api:check:smoke
bun run api:check:deep
```
