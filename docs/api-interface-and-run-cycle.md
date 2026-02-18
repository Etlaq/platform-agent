# API Interface and Run Cycle

This document defines the public v1 contract where projects own ordered runs, and only the latest run stays writable.

Scope note: this repository is backend-only. Clients should only rely on `/v1/*` endpoints below.

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
| `POST` | `/v1/projects` | Create/idempotently resolve a project |
| `GET` | `/v1/projects` | List projects |
| `GET` | `/v1/projects/:projectId` | Project summary |
| `POST` | `/v1/projects/:projectId/runs` | Create/idempotently resolve a new run |
| `POST` | `/v1/projects/:projectId/messages` | Chat-style continuation; creates next run |
| `GET` | `/v1/projects/:projectId/runs` | List runs in project |
| `GET` | `/v1/projects/:projectId/runs/:id` | Run summary |
| `GET` | `/v1/projects/:projectId/runs/:id/messages` | Run message history |
| `GET` | `/v1/projects/:projectId/runs/:id/stream` | SSE stream with replay support |
| `POST` | `/v1/projects/:projectId/runs/:id/cancel` | Cancel latest writable run |
| `GET` | `/v1/projects/:projectId/runs/:id/download.zip` | Download run workspace zip |

All older run-first paths (`/v1/runs/*`) are removed from v1.

## 2) Project and Run Ownership

- A project contains an ordered run timeline (`runIndex`).
- Only one run per project is writable at a time (`writable=true`).
- Creating a new run makes the previous writable run read-only automatically.
- Read-only runs remain available for summary, stream replay, message history, and download.

This gives a simple client contract while backend manages ordering and edge cases.

## 3) Run Creation Contract

`POST /v1/projects/:projectId/runs` body:

```json
{
  "prompt": "your task",
  "input": {},
  "stream": false,
  "provider": "openai|anthropic|google|groq|mistral|cohere|xai|zai|openrouter|kimi|qwen",
  "model": "optional-model-name",
  "workspaceBackend": "host|e2b"
}
```

Required:

- `prompt`
- `Idempotency-Key` request header

Idempotency behavior:

- same `(projectId, Idempotency-Key)` returns existing run
- duplicate retries do not create duplicate runs

Workspace backend behavior:

- `workspaceBackend` accepts `host` or `e2b`
- if omitted, backend resolves default from env (`AGENT_WORKSPACE_BACKEND` / `WORKSPACE_BACKEND`), else `e2b` when E2B credentials exist, else `host`

## 4) Chat-Style Project Messages

`POST /v1/projects/:projectId/messages` body:

```json
{
  "content": "continue and refine the project",
  "input": {}
}
```

Behavior:

- creates a new run from latest project context
- stores the user message for that run
- previous latest run becomes read-only
- requires `Idempotency-Key`

## 5) Run Summary Shape

`GET /v1/projects/:projectId/runs/:id` returns envelope data containing:

- run identity: `projectId`, `runIndex`, `writable`, `parentRunId`
- lifecycle: `status`, `createdAt`, `startedAt`, `completedAt`, `updatedAt`
- request context: `prompt`, `input`
- result: `output`, `error`
- usage: `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `reasoningOutputTokens`
- cost: `currency`, `estimatedUsd`, `pricingVersion`
- meta: `provider`, `model`, `modelSource`, `usageSource`, `pricingSource`, `attempt`, `maxAttempts`, `sandboxId`, `idempotencyKey`

## 6) Streaming and Reconnect

`GET /v1/projects/:projectId/runs/:id/stream` is SSE and supports replay via `Last-Event-ID`.

Properties:

- backend replays missed events after provided event id
- heartbeat `ping` emitted every 15s
- stream closes when run reaches terminal state (`completed|error|cancelled`)
- run execution continues even if client disconnects
- for E2B-backed runs, live command output is emitted as `tool` events with `phase: "stream"` and `stream: "stdout" | "stderr"` while commands execute

## 7) Cancel Semantics

`POST /v1/projects/:projectId/runs/:id/cancel`:

- cancels queued/running runs only
- only latest writable run is mutable for cancel
- completed/error runs return non-mutating response

## 8) Run Download Package

`GET /v1/projects/:projectId/runs/:id/download.zip` returns project workspace zip for that run.

Behavior:

- for `e2b` runs: returns stored `workspace.zip` artifact, or live sandbox zip while active
- for `host` runs: returns host workspace snapshot zip
- excludes sensitive files and env secrets (for example `.env`)
- excludes large generated/vendor directories (`node_modules`, `.next`, etc.)

## 9) Operational Notes

- Encore secret `AgentApiKey` must be set in cloud envs.
- Missing `AgentApiKey` blocks deploy during infrastructure validation.
- Cost estimates are computed from provider response usage metadata only.
- Pricing is resolved from `model_pricing` active rows by provider/model; no guessed fallback pricing is used.

## 10) Smoke / Deep Checks

```bash
export API_BASE=https://staging-platform-agent-3p2i.encr.app
export AGENT_API_KEY=<key>
export CHECK_PROJECT_ID=default

bun run api:check:smoke
bun run api:check:deep
```
