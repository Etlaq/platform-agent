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

## Rollback Model
- `project_actions.rollback_list_commits`: list recent git commits for selection.
- `project_actions.rollback_run`: restore selected commit snapshot as a new latest commit (no history rewrite).
- Rollback cost/usage metadata is independent; pricing remains response-usage driven via DB pricing rows.

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
- 2026-02-12T14:48:41.283Z | run_error/workspace_validation | Workspace rejected as non-Next.js project (`next` dependency missing).
- 2026-02-13T13:08:50.988Z | run_error/model_auth | Provider returned 401 `invalid x-api-key` (request_id: `req_011CY67zdNuVKF5f6sRvH3WL`).
- 2026-02-13T13:08:53.496Z | run_error/model_auth | Provider returned 401 `invalid x-api-key` (request_id: `req_011CY67zp8ZPPGWono9fAzxm`).
- 2026-02-13T13:08:58.482Z | run_error/model_auth | Provider returned 401 `invalid x-api-key` (request_id: `req_011CY681BRyPeVzSTqDYWG1o`).
- 2026-02-13T13:14:11.110Z | run_error/workspace_validation | Workspace rejected as non-Next.js project (`next` dependency missing).
- 2026-02-13T13:29:49.332Z | tool_error/dependency_bootstrap | Dependency add tool called while workspace validation still failing (`next` missing).
- 2026-02-13T13:44:48.639Z | run_error/workspace_validation | Workspace rejected as non-Next.js project (`next` dependency missing).
- 2026-02-17T21:20:00.000Z | docs_update/architecture | AGENTS.md rewritten for backend-first Encore architecture and canonical `/v1/*` guidance.
- 2026-02-17T22:20:48.000Z | deploy_lesson/auth | Direct Encore rollout API returned 401; local login state is not always enough for rollout API calls.
- 2026-02-17T22:20:48.000Z | contract_lesson/download_zip | `/v1/runs/:id/download.zip` must return workspace application files, not metadata pack (`run.json`, `events.json`, `artifacts.json`).
- 2026-02-17T22:20:48.000Z | run_debug/provider_config | Deep runs may stall with repeated empty token events when provider key/model config is invalid.
- 2026-02-17T22:45:00.000Z | rollback_update/git_based | Rollback flow now uses commit list selection plus forward restore commit (`rollback_list_commits` + `rollback_run`), no history rewrite.
- 2026-02-17T22:25:42.000Z | deploy_lesson/token_format | `~/.config/encore/.auth_token` is JSON; manual rollout API calls must use `.access_token` value, not raw file contents.
- 2026-02-17T22:25:42.000Z | rollout_verification/staging | Rollout `roll_1t5n0fsb0mgc1ufujj60` succeeded and `/v1/runs/:id/download.zip` on staging now returns workspace app files (contains `package.json`, `runs/api.ts`; no `run.json/events.json/artifacts.json`).
<!-- AGENTS_NOTES_END -->
