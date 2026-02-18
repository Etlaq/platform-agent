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
- SSE endpoints (`/v1/projects/:projectId/runs/:id/stream`) keep raw SSE event format
- Run-first routes (`/v1/runs/*`) are removed; use project-scoped routes only.

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
1. `POST /v1/projects/:projectId/runs` (or `POST /v1/projects/:projectId/messages`) queues run + job.
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

## Notes
<!-- AGENTS_NOTES_START -->
- `download.zip` serves workspace project files (source, config) — not run metadata snapshots like `run.json` or `events.json`. For E2B runs it uses the run-specific artifact zip first, then the live sandbox zip.
- `project_actions` requires a Next.js + Bun workspace; do not call it if `next` or `bun.lock` is missing.
- Rollback creates a new forward restore commit via `rollback_list_commits` + `rollback_run` — no history rewrite.
- Runs stalling with repeated empty token events usually mean an invalid provider key or model name.
<!-- AGENTS_NOTES_END -->
