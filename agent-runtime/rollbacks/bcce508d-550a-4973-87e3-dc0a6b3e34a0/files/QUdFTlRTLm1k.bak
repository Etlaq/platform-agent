# AGENTS.md

This file provides guidance when working with code in the agent_v2 repository.

## Commands

```bash
# Development
encore run                        # Start Encore API server (localhost:4000)

# Tests
npm test                          # All unit tests (Vitest)
npm test -- tests/unit/foo.test.ts              # Single test file
npm test -- tests/unit/foo.test.ts -t "name"    # Single test by name
npm run test:encore               # Encore integration tests (needs running DB)

# Type-checking
npm run typecheck                 # tsc --noEmit
```

There is no root `build` or `lint` script. Lint/build/typecheck for agent workspaces are exposed via the `project_actions` tool and `autoLint.ts`.

## Stack

Encore.dev · TypeScript (strict, ES2022) · DeepAgents · LangChain (OpenAI/Anthropic/xAI/Z.AI) · E2B Sandbox · PostgreSQL · Zod · Vitest

## Architecture

Encore-based agent execution platform for autonomous code generation/modification in Next.js + Bun projects. Uses DeepAgents middleware for LLM orchestration with LangChain providers.

### Encore Services

| Service | Path | Purpose |
|---------|------|---------|
| `auth` | `auth/` | API-key gateway (`X-Agent-Api-Key` header or Encore secret `AgentApiKey`) |
| `control` | `control/` | Public root `/`, `/health`, `/capabilities` endpoints |
| `runs` | `runs/` | Run lifecycle: `POST /runs`, `GET /runs/:id` (SSE), cancel, rollback |
| `worker` | `worker/` | Pub/Sub subscription processes queued runs; cron requeues stale jobs |
| `data` | `data/` | PostgreSQL queries (runs, events, jobs, artifacts) |
| `storage` | `storage/` | Object storage for rollback manifests (`agent-artifacts` bucket) |
| `sandbox` | `sandbox/` | E2B sandbox: `/exec`, `/sandbox/create`, dev server start/stop |
| `download` | `download/` | ZIP download of workspace or sandbox contents |
| `metrics` | `metrics/` | Plaintext Prometheus-style metrics |
| `agent` | `agent/` | Not an Encore service — the runtime engine used by `worker` |

### Request Flow

```
POST /runs → auth check → createQueuedRun (DB) → publish to "run-requested" Topic
  → Worker Subscription → runAgent()
  → SSE events streamed back via GET /runs/:id
```

### Two-Phase Agent Execution (`agent/runAgent.ts`)

1. **Plan phase** (read-only): Agent inspects workspace, returns structured JSON plan with todos. Mutating tool calls are blocked; violations emit `plan_policy_warning`.
2. **Build phase** (execution): Agent implements approved todos using filesystem tools, `project_actions`, `sandbox_cmd`, and MCP tools.
3. **Auto-lint** (E2B only): After a successful build, runs `bun run lint` up to N passes with agent-assisted fixes.

Phase progress is streamed via SSE status events (`phase_started`, `plan_ready`, `phase_transition`, `phase_completed`).

### Workspace Modes

- **host** — Direct filesystem via `GuardedFilesystemBackend` + `RollbackManager`. All mutations tracked in `agent-runtime/rollbacks/<runId>/manifest.json`.
- **e2b** — Isolated E2B sandbox via `E2BSandboxBackend` + `GuardedVirtualBackend`. Shell access via `sandbox_cmd` tool.

### Sandbox Template (`sandbox-template/`)

The starter Next.js project seeded into E2B sandboxes. Includes Next.js 16, React 19, Tailwind CSS 4 (OKLCH), shadcn/ui, RTL/LTR language toggle (Arabic-first), dark/light theme, and MongoDB/Mongoose. The agent's `AGENTS.project.md` template (`agent/templates/`) is written to match this stack. When modifying the sandbox template, keep the `AGENTS.md` and `CLAUDE.md` inside it in sync.

#### Building E2B Templates

The sandbox template includes E2B build scripts for creating sandbox images:

```bash
cd sandbox-template
npm install               # installs e2b + dotenv (build tooling)
npx tsx build.dev.ts      # build dev template (e2b-sandbox-nextjs-dev)
npx tsx build.prod.ts     # build prod template (e2b-sandbox-nextjs)
```

- `template.ts` — Defines the E2B template: starts from a Bun 1.3 image, clones the Next.js starter from GitHub, runs `bun install`, and sets `bun run dev --turbo` as the start command.
- `build.dev.ts` / `build.prod.ts` — Build the template with 4GB RAM / 2 CPUs via the E2B SDK. Requires `E2B_API_KEY` in env.
- The resulting template ID is what you set as `E2B_TEMPLATE` in the agent's env.

### Composite Backend Routing

`runAgent` constructs a `CompositeBackend` that routes virtual paths:
- `/memories/` → `FilesystemBackend` (long-term agent memory)
- `/skills/` → `FilesystemBackend` (reference docs)
- `/host/` → `GuardedFilesystemBackend` or `E2BSandboxBackend` (workspace)

### Model Provider Resolution (`agent/provider.ts`)

Resolution order: request param → `AGENT_PROVIDER` env → auto-detect by key presence (OpenAI → xAI → Z.AI → Anthropic). Default models: `gpt-5`, `grok-2-latest`, `glm-4.7`, `claude-opus-4-6`.

### MCP Integration (`agent/runtime/mcp.ts`)

External tools loaded from `MCP_SERVERS` env (JSON inline) or `MCP_SERVERS_PATH` (file path). Uses `@langchain/mcp-adapters` `MultiServerMCPClient`. Config shape: `{ mcpServers: { [name]: {...} } }`.

### Database Schema (`data/migrations/`)

Four tables: `runs` (UUID PK, status lifecycle), `events` (ordered SSE stream per run, UNIQUE on run_id+seq), `jobs` (retry queue with backoff), `artifacts` (output files). Persistence requires `DATABASE_URL`; without it, runs execute in-memory only.

### Job Processing (`worker/queue.ts`, `worker/cron.ts`)

- Pub/Sub topic `run-requested` with at-least-once delivery
- Exponential backoff retries (2^attempts seconds, max `WORKER_MAX_BACKOFF`)
- Cancellation polling every 750ms during execution
- Cron job every 1m requeues stale running jobs (disabled by default; set `WORKER_REQUEUE_RUNNING_AFTER_S > 0`)

## Code Style

- TypeScript strict mode, ES2022 target/module.
- 2-space indent, single quotes, no semicolons, trailing commas in multiline.
- `node:` specifiers for built-ins (`node:fs`, `node:path`).
- Zod for all request/schema validation.
- Encore `api`/`api.raw` with typed return interfaces for endpoints.
- Path alias `~encore/*` maps to `./encore.gen/*` (generated Encore SDK).
- Vitest for tests; fixtures in `tests/fixtures/`, temp dirs via `tests/helpers/tmp.ts`.

## Critical Invariants

1. **Path policy**: Never weaken deny lists in `pathPolicy.ts` or `guardedFilesystemBackend.ts`. Blocked: `.env`, `.env.*` (except `.env.example`), `.pem`, `.key`, `.npmrc`, `.git-credentials`, `.git/`, `node_modules/`, `.next/`, `dist/`, `build/`, `.cache/`, `.turbo/`.
2. **Rollback integrity**: All file mutations in host mode must go through `RollbackManager`.
3. **Auth guards**: `AGENT_API_KEY` required on all control-plane endpoints (everything except `/health`, `/`, `/capabilities`).
4. **ALLOW_HOST_INSTALLS gate**: Install/build/typecheck commands in host mode must check this env var.
5. **Secret isolation**: `.env` values must never appear in agent output, logs, or tool responses.
6. **Plan-phase immutability**: Mutating actions (`add_dependencies`, `run_install`, `run_next_build`, `run_typecheck`, `scaffold_*`, `generate_drizzle_migration`, `secrets_sync_env_example`, `validate_env`, `rollback_run`) are blocked during plan phase.

## Key Files

- `agent/runAgent.ts` — Central orchestrator (plan → build → auto-lint)
- `agent/provider.ts` — Model provider resolution chain
- `agent/runtime/config.ts` — System prompts, directory resolution, env helpers
- `agent/runtime/mcp.ts` — MCP server tool loading
- `agent/runtime/modelFactory.ts` — LLM provider instantiation
- `agent/backends/pathPolicy.ts` — File access security policy
- `agent/rollback/rollbackManager.ts` — Change tracking and reversal
- `agent/tools/projectActions/handlers.ts` — Action dispatch map
- `agent/autoLint.ts` — Post-build lint loop (E2B only)
- `worker/queue.ts` — Pub/Sub topic + retry logic
- `worker/cron.ts` — Stale job requeue cron
- `data/db.ts` — All SQL queries
- `data/migrations/001_initial_schema.up.sql` — DB schema
- `sandbox-template/` — Next.js starter project seeded into E2B sandboxes
- `agent/templates/AGENTS.project.md` — AGENTS.md template written into sandboxes

## Environment

**Required:**
- `AGENT_API_KEY` — Auth for control-plane endpoints
- At least one LLM key: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY` / `ZAI_API_KEY`

**Agent runtime:**
- `AGENT_PROVIDER` / `AGENT_MODEL` — Force provider/model selection
- `WORKSPACE_ROOT` — Workspace path (default: `/workspace` or cwd)
- `ALLOW_HOST_INSTALLS` — Enable shell commands in host mode
- `SEED_AGENTS_MD` / `ENABLE_SUBAGENTS` — Agent behavior toggles

**E2B sandbox:**
- `E2B_API_KEY` + `E2B_TEMPLATE` — Enable sandbox mode
- `SANDBOX_APP_DIR`, `E2B_SANDBOX_TIMEOUT_MS`

**Observability:**
- `LANGSMITH_TRACING=true` + `LANGSMITH_API_KEY` — LangSmith tracing

**Persistence (optional):**
- `DATABASE_URL` — PostgreSQL connection (without it, runs are in-memory only)

See `.env.example` for the template.

## Notes (Append Only)
<!-- AGENTS_NOTES_START -->
<!-- AGENTS_NOTES_END -->
