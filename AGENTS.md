# AGENTS.md

Quick reference for subagents working in this repository.

## Commands
```bash
bun dev                  # Run Encore API locally (http://localhost:4000)
bun test                 # Unit tests
bun run typecheck        # Type check
encore check             # Validate Encore endpoint declarations
bun run api:check:smoke  # v1 smoke check (requires AGENT_API_KEY)
bun run api:check:deep   # v1 deep check (requires AGENT_API_KEY)
```

## Stack
Encore.ts · Bun · TypeScript · LangChain/DeepAgents · E2B sandbox · PostgreSQL (`pg`)

## Critical Rules

1. **Read before edit** - Never modify files without reading them first
2. **`/v1/*` is canonical API** - Keep legacy non-versioned paths only for compatibility
3. **Auth model** - Protected endpoints require `X-Agent-Api-Key` or `Authorization: Bearer`
4. **Secret precedence** - `AgentApiKey` secret first, `AGENT_API_KEY` env fallback
5. **Never break run lifecycle events** - Preserve ordering/shape consumed by worker/tests
6. **No `any` when avoidable** - Keep types explicit on API request/response shapes
7. **Run `encore check` after endpoint refactors** - Encore only registers exported endpoint bindings

## API Contract
- v1 JSON endpoints use envelope: `{ ok, data, meta: { apiVersion: "v1", ts } }`
- SSE endpoints (`/v1/runs/:id/stream` and streamed `POST /v1/runs`) keep raw SSE event format
- Legacy routes still return pre-v1 raw JSON where applicable

## File Structure
```
auth/        # gateway + auth handler
control/     # root, health, capabilities
runs/        # run creation/listing/stream/events/artifacts/rollback
sandbox/     # /exec and sandbox lifecycle endpoints
download/    # zip download endpoints (host + sandbox)
metrics/     # metrics endpoints (json + prometheus)
worker/      # queue consumer + cron kick/requeue
data/        # db access layer + migrations
common/      # shared helpers/contracts
agent/       # runtime orchestration (plan/build phases)
```

## Key Runtime Flow
1. `POST /v1/runs` queues run + job, optionally opens SSE stream.
2. Worker claims queued job, executes `runAgent` in plan/build phases.
3. Events persist in `events` table and stream to clients.
4. Finalization updates run/job status and usage/duration/provider/model metadata.

## High-Risk Areas
- `runs/api.ts`: response shape and SSE behavior
- `agent/runAgent.ts`: phase transitions, timeouts, emitted status payloads
- `worker/queue.ts`: completion/error/cancel semantics and retries
- `sandbox/api.ts` + `common/e2bSandbox.ts`: timeout handling for E2B commands
- `auth/auth.ts`: key resolution and auth header parsing

## Debug Checklist
1. `encore check`
2. `bun run typecheck`
3. `bun test`
4. For deployed verification: `bun run api:check:smoke` or `bun run api:check:deep`
5. If deploy fails before runtime, verify required Encore secrets exist (especially `AgentApiKey`)

## Notes (Append Only)
<!-- AGENTS_NOTES_START -->
- 2026-02-12T14:48:41.283Z: run_error: Workspace is not a Next.js project (missing next dependency).
- 2026-02-13T13:08:50.988Z: run_error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CY67zdNuVKF5f6sRvH3WL"} Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/
- 2026-02-13T13:08:53.496Z: run_error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CY67zp8ZPPGWono9fAzxm"} Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/
- 2026-02-13T13:08:58.482Z: run_error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CY681BRyPeVzSTqDYWG1o"} Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/
- 2026-02-13T13:14:11.110Z: run_error: Workspace is not a Next.js project (missing next dependency).
- 2026-02-13T13:29:49.332Z: tool=tool | tool_error: Workspace is not a Next.js project (missing next dependency). | input={"action":"add_dependencies","deps":[{"name":"next","version":"^16.0.0","dev":false},{"name":"react","version":"^19.0.0","dev":false},{"name":"react-dom","version":"^19.0.0","dev":false},{"name":"tail
- 2026-02-13T13:44:48.639Z: run_error: Workspace is not a Next.js project (missing next dependency).
- 2026-02-17T21:20:00.000Z: docs_update: AGENTS.md updated to backend-focused Encore architecture with canonical /v1 API guidance.
<!-- AGENTS_NOTES_END -->
