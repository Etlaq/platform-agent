# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                                     # Install dependencies
bun dev / encore run                            # Start API locally (http://localhost:4000)
bun test                                        # Unit tests
bun test -- tests/unit/foo.test.ts              # Single test file
bun test -- tests/unit/foo.test.ts -t "name"    # Single test by name
bun run test:encore                             # Encore integration tests
bun run typecheck                               # TypeScript check (tsc --noEmit)
encore check                                    # Validate Encore endpoint declarations
bun run api:check:smoke                         # Smoke check against API_BASE
bun run api:check:deep                          # Deep check against API_BASE
```

After any endpoint refactor, always run `encore check` — Encore only registers exported endpoint bindings.

### Debug Checklist

1. `encore check`
2. `bun run typecheck`
3. `bun test`
4. For deployed verification: set `API_BASE` and `AGENT_API_KEY`, then `bun run api:check:smoke` or `bun run api:check:deep`
5. If deploy fails before runtime, verify required Encore secrets exist (especially `AgentApiKey`)

## Architecture

This is a **backend-only** autonomous code-generation agent built on [Encore.ts](https://encore.dev). It accepts a prompt, executes plan/build phases using an LLM, and streams results via SSE. The core LLM integration uses the [deepagents](https://www.npmjs.com/package/deepagents) library with LangChain model adapters.

### Services (Encore)

Each subdirectory with `encore.service.ts` is an Encore service:

| Service | Directory | Role |
|---------|-----------|------|
| `auth` | `auth/` | API-key gateway (`X-Agent-Api-Key` or `Authorization: Bearer`) |
| `control` | `control/` | Root, health, capabilities endpoints |
| `runs` | `runs/` | Public project/run API — projects, runs, messages, stream, cancel, download |
| `worker` | `worker/` | Pub/Sub consumer + stale-run cron |
| `data` | `data/` | PostgreSQL persistence (migrations in `data/migrations/`) |
| `storage` | `storage/` | Object storage for run artifacts and workspace zips |
| `sandbox` | `sandbox/` | E2B sandbox management (internal) |
| `download` | `download/` | Workspace zip tooling (internal) |
| `metrics` | `metrics/` | Monitoring endpoints (internal) |

### Agent Engine (`agent/` — not an Encore service)

`agent/runAgent.ts` is the core. It orchestrates two sequential LLM phases:

1. **Plan phase** — read-only; LLM returns a JSON `{ summary, todos[] }` block
2. **Build phase** — LLM executes the approved plan using tools

Key files:
- `agent/runAgent.ts` — main orchestrator, phase transitions, event emission, usage accumulation
- `agent/provider.ts` — provider resolution (openai/anthropic/google/groq/mistral/cohere/xai/zai/openrouter/kimi/qwen) from env or request
- `agent/runtime/modelFactory.ts` — creates LangChain chat models with Undici timeout dispatcher
- `agent/runtime/config.ts` — system prompts, phase prompt appendices, workspace/dir resolution
- `agent/tools/projectActions.ts` — policy-guarded tool for host-mode (bun install, scaffolding, rollback)
- `agent/tools/sandboxCmd.ts` — arbitrary shell commands in E2B mode
- `agent/backends/` — `GuardedFilesystemBackend` (host), `GuardedVirtualBackend` (e2b), `E2BSandboxBackend`, `ObservableBackend` (wraps any backend to emit `file_op` events)
- `agent/rollback/` — git-based rollback manager for host-mode runs
- `agent/planParser.ts` — parses plan JSON from LLM output; builds fallback plan if parsing fails
- `agent/callbacks.ts` — LangChain callback handler that bridges agent events to SSE
- `agent/usage.ts` — accumulates token usage from message metadata
- `agent/sandboxGit.ts` — git init/snapshot helpers for E2B sandboxes

### Run Lifecycle

```
POST /v1/projects/:projectId/runs (or /messages)  →  createProjectRun (data)  →  enqueueRun (worker Pub/Sub Topic)
                                                        ↓
                                          worker Subscription claims job
                                                        ↓
                                          runAgent (plan → build → auto-lint?)
                                                        ↓
                                          completeRun / failRun / retry/backoff
```

Events flow: `insertEventWithNextSeq` → persisted in `events` table → streamed via SSE with `Last-Event-ID` replay.

### Workspace Modes

- **`host`** — Direct filesystem with path policy enforcement; git rollback via `RollbackManager`. Auto-commits after successful runs unless `AUTO_GIT_COMMIT=false`.
- **`e2b`** — Isolated E2B sandbox. After build, optional auto-lint pass runs `bun run lint`. Run-specific workspace zip stored as artifact before sandbox cleanup.

Workspace backend resolution order (when not specified in request):
1. `AGENT_WORKSPACE_BACKEND` / `WORKSPACE_BACKEND` env override
2. `e2b` when both `E2B_API_KEY` and `E2B_TEMPLATE` are available
3. Fallback `host`

### API Contract

All `/v1/*` JSON responses use envelope: `{ ok, data, meta: { apiVersion: "v1", ts } }` (defined in `common/apiContract.ts`).

SSE endpoints keep raw SSE format.

Auth: `AgentApiKey` Encore secret takes precedence over `AGENT_API_KEY` env. Same for provider secrets (e.g., `AnthropicApiKey` / `ANTHROPIC_API_KEY`).

`POST` endpoints for runs and messages require an `Idempotency-Key` header to prevent duplicate creation on retried requests.

### Database Schema

Tables: `projects`, `runs`, `run_messages`, `events`, `jobs`, `artifacts`, `model_pricing`. Migrations are in `data/migrations/` and are numbered sequentially (`001_...`, `002_...`, currently through `005_`). The `~encore/*` path alias maps to `encore.gen/`.

### Rollback Model (host mode)

- `project_actions.rollback_list_commits` — list recent git commits for selection
- `project_actions.rollback_run` — restore selected commit snapshot as a new forward commit (no history rewrite)
- `project_actions` tool requires a Next.js + Bun workspace; do not call it if `next` or `bun.lock` is missing

## Critical Rules

1. **`/v1/*` is canonical API** — only these endpoints are part of the public client contract; run-first routes (`/v1/runs/*`) are removed, use project-scoped routes only
2. **Never break run lifecycle events** — preserve ordering and shape consumed by worker and tests
3. **Run `encore check` after endpoint refactors** — Encore only registers exported endpoint bindings
4. **Auth precedence** — Encore secret first, env fallback; applies to `AgentApiKey` and provider keys
5. **No `any` on API shapes** — keep request/response types explicit
6. **`/v1/projects/:projectId/runs/:id/download.zip`** must return workspace application files (not `run.json`/`events.json`)
7. **E2B runs** persist a run-specific workspace zip before sandbox cleanup; host runs are zipped from filesystem

## High-Risk Areas

- `runs/api.ts` — response shape and SSE behavior
- `agent/runAgent.ts` — phase transitions, timeouts, emitted status payloads
- `worker/queue.ts` — completion/error/cancel semantics and retries
- `auth/auth.ts` — key resolution and auth header parsing
- `common/e2bSandbox.ts` — timeout handling for E2B commands

## Troubleshooting

- Runs stalling with repeated empty token events usually mean an invalid provider key or model name
- Worker secrets are resolved via `secret()` from Encore config at subscription init time — if a secret is missing, the worker silently skips setting the env var (existing runtime checks surface clear errors when required values are absent)
- The `tests/unit/` directory uses Bun's built-in test runner; tests do not require a running Encore instance or database
