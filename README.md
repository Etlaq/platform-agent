# Platform Agent

Autonomous code-generation agent backend built on [Encore](https://encore.dev). Accepts a prompt, plans changes, executes them in a sandboxed or host workspace, and streams results back via SSE.

This repository is backend-only (API + worker services). It does not ship a production frontend.

## Quick Start

```bash
bun install
encore run          # API on http://localhost:4000
```

Copy `.env.example` to `.env` and fill in at minimum:

```
AGENT_API_KEY=<your-key>
OPENAI_API_KEY=<or any supported provider key>
```

For Encore cloud deployments, also define required Encore secrets (especially `AgentApiKey`), or deployment will fail during infrastructure validation.

## API

`/v1/*` is the canonical API surface.

All endpoints except `/`, `/v1`, `/health`, `/capabilities`, `/v1/health`, and `/v1/capabilities` require the `X-Agent-Api-Key` header.
Detailed request/worker lifecycle and troubleshooting are documented in `docs/api-interface-and-run-cycle.md`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Root info |
| GET | `/v1` | Versioned root info |
| GET | `/v1/health` | Health check |
| GET | `/v1/capabilities` | Supported actions and constraints |
| POST | `/v1/projects` | Create (or idempotently resolve) a project |
| GET | `/v1/projects` | List projects |
| GET | `/v1/projects/:projectId` | Project summary |
| POST | `/v1/projects/:projectId/runs` | Create (or idempotently resolve) an async run (becomes latest writable run) |
| POST | `/v1/projects/:projectId/messages` | Chat-style project message; creates the next latest writable run |
| GET | `/v1/projects/:projectId/runs` | List runs for a project (latest first) |
| GET | `/v1/projects/:projectId/runs/:id` | Run summary (JSON envelope) |
| GET | `/v1/projects/:projectId/runs/:id/messages` | Persisted message list for that run |
| GET | `/v1/projects/:projectId/runs/:id/stream` | SSE event stream for a run |
| POST | `/v1/projects/:projectId/runs/:id/cancel` | Cancel latest writable run |
| GET | `/v1/projects/:projectId/runs/:id/download.zip` | Download run workspace zip (run-specific app files) |

Older workflow/sandbox/metrics endpoints are now internal-only and no longer part of the public client contract.

### Creating a Project and Run

```bash
curl -X POST http://localhost:4000/v1/projects \
  -H "X-Agent-Api-Key: $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"default","name":"Default Project"}'

curl -X POST http://localhost:4000/v1/projects/default/runs \
  -H "X-Agent-Api-Key: $AGENT_API_KEY" \
  -H "Idempotency-Key: run-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Add a dark mode toggle","stream":false,"workspaceBackend":"e2b"}'
```

The response includes a run `id`. Stream events with `GET /v1/projects/:projectId/runs/:id/stream` (SSE).
For chat-like continuation, call `POST /v1/projects/:projectId/messages` with `content`.

`workspaceBackend` can be `host` or `e2b`. If omitted, backend default resolution is:

1. `AGENT_WORKSPACE_BACKEND` / `WORKSPACE_BACKEND` env override.
2. `e2b` when both `E2B_API_KEY` and `E2B_TEMPLATE` are available.
3. fallback `host`.

## How It Works

Each run is processed in two phases:

1. **Plan** — The agent reads the workspace (read-only) and returns a structured JSON plan with todos.
2. **Build** — The agent executes the approved plan, modifying files and running commands.

In E2B mode, an optional **auto-lint** pass runs after build to fix lint errors automatically.

After successful host runs, workspace changes are staged and committed to Git automatically (unless `AUTO_GIT_COMMIT=false`).

Reliability semantics:

- Run execution is async and continues even if client/network disconnects.
- Reconnect with `GET /v1/projects/:projectId/runs/:id/stream` and `Last-Event-ID` for replay.
- `POST /v1/projects/:projectId/runs` and `POST /v1/projects/:projectId/messages` require `Idempotency-Key` to prevent duplicate creation on retried requests.
- Worker retries, stale-run requeue, and sandbox cleanup are managed internally by backend workers.
- For `e2b` runs, worker stores a run-specific workspace zip artifact before sandbox cleanup.
- For `e2b` runs, command stdout/stderr is streamed in real time as SSE `tool` events (`phase: "stream"`).

## Services

| Service | Path | Purpose |
|---------|------|---------|
| `auth` | `auth/` | API-key authentication gateway |
| `control` | `control/` | Health, capabilities, root endpoints |
| `runs` | `runs/` | Public run lifecycle API (simple client contract) |
| `worker` | `worker/` | Pub/Sub job processor and stale-run cron |
| `data` | `data/` | PostgreSQL persistence layer |
| `storage` | `storage/` | Object storage helpers for run artifacts/JSON payloads |
| `sandbox` | `sandbox/` | Internal E2B sandbox management |
| `download` | `download/` | Internal workspace/sandbox zip tooling |
| `metrics` | `metrics/` | Internal monitoring endpoints |

The `agent/` directory contains the runtime engine (not an Encore service) — orchestrator, backends, tools, and rollback manager.

## Workspace Modes

- **host** — Direct filesystem access with path policy enforcement and git-backed rollback controls.
- **e2b** — Isolated [E2B](https://e2b.dev) sandbox with limited command access via `sandbox_cmd` tool.

## Pricing Accuracy

- Usage/token counters are sourced from provider response metadata, not prompt/input size estimates.
- Estimated USD cost is computed from `model_pricing` table rows for the resolved provider+model.
- If no active pricing row exists for a model, cost estimate is left `null` rather than guessing.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `AGENT_API_KEY` | Auth key for control-plane endpoints |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` / `COHERE_API_KEY` / `XAI_API_KEY` / `ZAI_API_KEY` / `OPENROUTER_API_KEY` / `KIMI_API_KEY` / `MOONSHOT_API_KEY` / `QWEN_API_KEY` / `ALIBABA_API_KEY` / `DASHSCOPE_API_KEY` | At least one LLM provider key |

### Optional

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection (enables persistence; without it, runs are in-memory) |
| `AGENT_PROVIDER` | Force a specific provider (`openai`, `anthropic`, `google`, `groq`, `mistral`, `cohere`, `xai`, `zai`, `openrouter`, `kimi`, `qwen`) |
| `AGENT_MODEL` | Override default model name |
| `WORKSPACE_ROOT` | Workspace path (default: `/workspace` or cwd) |
| `AGENT_WORKSPACE_BACKEND` / `WORKSPACE_BACKEND` | Default workspace backend (`host` or `e2b`) |
| `ALLOW_HOST_INSTALLS` | Enable `bun install/build/typecheck` in host mode |
| `E2B_API_KEY` | E2B sandbox API key |
| `E2B_TEMPLATE` | E2B template ID |
| `MCP_SERVERS` | JSON config for MCP tool servers |
| `AUTO_GIT_COMMIT` | Disable/enable auto-commit after successful host runs (`false` disables; default enabled) |
| `AGENT_GIT_AUTHOR_NAME` / `AGENT_GIT_AUTHOR_EMAIL` | Optional Git author identity for auto-commits |
| `AGENT_GIT_COMMITTER_NAME` / `AGENT_GIT_COMMITTER_EMAIL` | Optional Git committer identity for auto-commits |
| `LANGSMITH_TRACING` | Enable LangSmith tracing (`true`) |
| `LANGSMITH_API_KEY` | LangSmith API key |
| `GOOGLE_API_KEY` / `GOOGLE_MODEL` / `GOOGLE_BASE_URL` | Optional Google provider config (`AGENT_PROVIDER=google`) |
| `GROQ_API_KEY` / `GROQ_MODEL` / `GROQ_BASE_URL` | Optional Groq provider config (`AGENT_PROVIDER=groq`) |
| `MISTRAL_API_KEY` / `MISTRAL_MODEL` / `MISTRAL_BASE_URL` | Optional Mistral provider config (`AGENT_PROVIDER=mistral`) |
| `COHERE_API_KEY` / `COHERE_MODEL` | Optional Cohere provider config (`AGENT_PROVIDER=cohere`) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` / `OPENROUTER_BASE_URL` | Optional OpenRouter provider config (`AGENT_PROVIDER=openrouter`) |
| `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` | Optional OpenRouter attribution headers (`HTTP-Referer`, `X-Title`) |
| `KIMI_API_KEY` / `KIMI_MODEL` / `KIMI_BASE_URL` | Optional Kimi provider config (`AGENT_PROVIDER=kimi`) |
| `MOONSHOT_API_KEY` / `MOONSHOT_MODEL` / `MOONSHOT_BASE_URL` | Compatibility aliases for Kimi env vars |
| `QWEN_API_KEY` / `QWEN_MODEL` / `QWEN_BASE_URL` | Optional Qwen provider config (`AGENT_PROVIDER=qwen`) |
| `ALIBABA_API_KEY` / `ALIBABA_MODEL` / `ALIBABA_BASE_URL` | Compatibility aliases for Qwen env vars |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_MODEL` / `DASHSCOPE_BASE_URL` | Compatibility aliases for Qwen env vars |

## Development

```bash
bun test                                        # Unit tests
bun test -- tests/unit/foo.test.ts              # Single file
bun test -- tests/unit/foo.test.ts -t "name"    # Single test
bun run test:encore                             # Integration tests
bun run typecheck                               # Type check
bun run api:check:smoke                         # API smoke check (/v1)
bun run api:check:deep                          # API deep check (/v1)
```

## CI/CD (GitHub Actions -> Encore Rollout)

This repo now includes `.github/workflows/ci-cd.yml`:

- On `pull_request` to `master`: runs install + typecheck + unit tests.
- On `push` to `master`: runs the same checks, then triggers an Encore rollout for the pushed commit SHA via Encore's API.

Required GitHub repository secrets:

| Secret | Description |
|---|---|
| `ENCORE_APP_ID` | Encore app id (for this repo: `platform-agent-3p2i`) |
| `ENCORE_ENV_NAME` | Target environment name (for example `staging`) |
| `ENCORE_ACCESS_TOKEN` | Optional direct Encore API bearer token (fastest setup; rotate when expired) |
| `ENCORE_CLIENT_ID` | OAuth client id for Encore API access (recommended long-term) |
| `ENCORE_CLIENT_SECRET` | OAuth client secret for Encore API access (recommended long-term) |

Auth requirement: set `ENCORE_ACCESS_TOKEN` **or** both `ENCORE_CLIENT_ID` + `ENCORE_CLIENT_SECRET`.

Required Encore environment secret:

| Secret | Description |
|---|---|
| `AgentApiKey` | Required by infrastructure validation (missing it blocks deploy) |

Setup guide: `docs/deployment-cicd.md`

## Verification Against Deployed Envs

```bash
export API_BASE=https://staging-platform-agent-3p2i.encr.app
export AGENT_API_KEY=<your-key>

bun run api:check:smoke
bun run api:check:deep
```

Optional knobs:

- `CHECK_PROJECT_ID=<project-id>`
- `CHECK_PROVIDER=<provider>`
- `CHECK_MODEL=<model>`

## License

Proprietary.
