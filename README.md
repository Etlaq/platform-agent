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
| POST | `/v1/runs` | Create a new agent run |
| GET | `/v1/runs/:id` | Run summary (JSON envelope) |
| GET | `/v1/runs/:id/stream` | SSE event stream for a run |
| POST | `/v1/runs/:id/cancel` | Cancel a running job |
| GET | `/v1/runs/:id/events` | List run events |
| GET | `/v1/runs/:id/artifacts` | List run artifacts |
| GET | `/v1/runs/:id/rollback` | Get rollback manifest |
| POST | `/v1/runs/:id/rollback` | Restore workspace to pre-run state |
| GET | `/v1/workflows/status` | Queue/worker workflow health and counts |
| POST | `/v1/workflows/kick` | Enqueue runnable queued jobs immediately |
| POST | `/v1/workflows/requeue-stale` | Recover stale running jobs and re-enqueue |
| POST | `/v1/exec` | Execute command in E2B sandbox |
| POST | `/v1/sandbox/create` | Create E2B sandbox |
| POST | `/v1/sandbox/info` | Sandbox info |
| POST | `/v1/sandbox/dev/start` | Start sandbox dev server |
| POST | `/v1/sandbox/dev/stop` | Stop sandbox dev server |
| GET | `/v1/download.zip` | Download workspace as ZIP (includes `.git`) |
| GET | `/v1/sandbox/:id/download.zip` | Download sandbox workspace as ZIP |
| GET | `/v1/metrics` | JSON metrics snapshot |
| GET | `/v1/metrics/prometheus` | Prometheus-style metrics text |

Legacy non-versioned routes remain available for backward compatibility.

### Creating a Run

```bash
curl -X POST http://localhost:4000/v1/runs \
  -H "X-Agent-Api-Key: $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Add a dark mode toggle", "stream": true}'
```

The response includes a run `id`. Stream events with `GET /v1/runs/:id/stream` (SSE).

## How It Works

Each run is processed in two phases:

1. **Plan** — The agent reads the workspace (read-only) and returns a structured JSON plan with todos.
2. **Build** — The agent executes the approved plan, modifying files and running commands.

In E2B mode, an optional **auto-lint** pass runs after build to fix lint errors automatically.

After successful host runs, workspace changes are staged and committed to Git automatically (unless `AUTO_GIT_COMMIT=false`).

## Workflow Control

The backend now exposes workflow control APIs so run processing can be operated directly from this service:

- `GET /v1/workflows/status`
- `POST /v1/workflows/kick`
- `POST /v1/workflows/requeue-stale`

These use the same queue knobs as the worker cron (`WORKER_KICK_QUEUED_LIMIT`, `WORKER_KICK_QUEUED_MIN_AGE_S`, `WORKER_REQUEUE_RUNNING_AFTER_S`).

```bash
curl -s -H "X-Agent-Api-Key: $AGENT_API_KEY" http://localhost:4000/v1/workflows/status | jq '.data.queue'
curl -s -X POST -H "X-Agent-Api-Key: $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"limit":25,"minQueuedAgeSeconds":15}' http://localhost:4000/v1/workflows/kick | jq '.data'
curl -s -X POST -H "X-Agent-Api-Key: $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"staleSeconds":120}' http://localhost:4000/v1/workflows/requeue-stale | jq '.data'
```

## Services

| Service | Path | Purpose |
|---------|------|---------|
| `auth` | `auth/` | API-key authentication gateway |
| `control` | `control/` | Health, capabilities, root endpoints |
| `runs` | `runs/` | Run lifecycle and SSE streaming |
| `worker` | `worker/` | Pub/Sub job processor and stale-run cron |
| `data` | `data/` | PostgreSQL persistence layer |
| `storage` | `storage/` | Object storage for rollback manifests |
| `sandbox` | `sandbox/` | E2B sandbox management |
| `download` | `download/` | ZIP download endpoint |
| `metrics` | `metrics/` | Monitoring endpoint |

The `agent/` directory contains the runtime engine (not an Encore service) — orchestrator, backends, tools, and rollback manager.

## Workspace Modes

- **host** — Direct filesystem access with path policy enforcement and rollback tracking.
- **e2b** — Isolated [E2B](https://e2b.dev) sandbox with limited command access via `sandbox_cmd` tool.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `AGENT_API_KEY` | Auth key for control-plane endpoints |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY` / `ZAI_API_KEY` | At least one LLM provider key |

### Optional

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection (enables persistence; without it, runs are in-memory) |
| `AGENT_PROVIDER` | Force a specific provider (`openai`, `anthropic`, `xai`, `zai`) |
| `AGENT_MODEL` | Override default model name |
| `WORKSPACE_ROOT` | Workspace path (default: `/workspace` or cwd) |
| `ALLOW_HOST_INSTALLS` | Enable `bun install/build/typecheck` in host mode |
| `E2B_API_KEY` | E2B sandbox API key |
| `E2B_TEMPLATE` | E2B template ID |
| `MCP_SERVERS` | JSON config for MCP tool servers |
| `AUTO_GIT_COMMIT` | Disable/enable auto-commit after successful host runs (`false` disables; default enabled) |
| `AGENT_GIT_AUTHOR_NAME` / `AGENT_GIT_AUTHOR_EMAIL` | Optional Git author identity for auto-commits |
| `AGENT_GIT_COMMITTER_NAME` / `AGENT_GIT_COMMITTER_EMAIL` | Optional Git committer identity for auto-commits |
| `LANGSMITH_TRACING` | Enable LangSmith tracing (`true`) |
| `LANGSMITH_API_KEY` | LangSmith API key |

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
| `ENCORE_CLIENT_ID` | OAuth client id for Encore API access |
| `ENCORE_CLIENT_SECRET` | OAuth client secret for Encore API access |
| `ENCORE_APP_ID` | Encore app id (for this repo: `platform-agent-3p2i`) |
| `ENCORE_ENV_NAME` | Target environment name (for example `staging`) |

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

- `CHECK_WORKSPACE_BACKEND=host|e2b`
- `CHECK_PROVIDER=<provider>`
- `CHECK_MODEL=<model>`

## License

Proprietary.
