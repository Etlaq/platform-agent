# Platform Agent

Autonomous code-generation agent backend built on [Encore](https://encore.dev). Accepts a prompt, plans changes, executes them in a sandboxed or host workspace, and streams results back via SSE.

## Quick Start

```bash
npm install
encore run          # API on http://localhost:4000
```

Copy `.env.example` to `.env` and fill in at minimum:

```
AGENT_API_KEY=<your-key>
OPENAI_API_KEY=<or any supported provider key>
```

## API

All endpoints except `/`, `/health`, and `/capabilities` require the `X-Agent-Api-Key` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Root info |
| GET | `/health` | Health check |
| GET | `/capabilities` | Supported actions and constraints |
| POST | `/runs` | Create a new agent run |
| GET | `/runs/:id` | SSE event stream for a run |
| POST | `/runs/:id/cancel` | Cancel a running job |
| GET | `/runs/:id/events` | List run events |
| GET | `/runs/:id/artifacts` | List run artifacts |
| GET | `/runs/:id/rollback` | Get rollback manifest |
| POST | `/runs/:id/rollback` | Restore workspace to pre-run state |
| POST | `/exec` | Execute command in E2B sandbox |
| POST | `/sandbox/create` | Create E2B sandbox |
| GET | `/sandbox/:id/info` | Sandbox info |
| POST | `/sandbox/:id/dev/start` | Start sandbox dev server |
| POST | `/sandbox/:id/dev/stop` | Stop sandbox dev server |
| GET | `/download.zip` | Download workspace as ZIP |
| GET | `/metrics` | Prometheus-style metrics |

### Creating a Run

```bash
curl -X POST http://localhost:4000/runs \
  -H "X-Agent-Api-Key: $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Add a dark mode toggle", "stream": true}'
```

The response includes a run `id`. Stream events with `GET /runs/:id` (SSE).

## How It Works

Each run is processed in two phases:

1. **Plan** — The agent reads the workspace (read-only) and returns a structured JSON plan with todos.
2. **Build** — The agent executes the approved plan, modifying files and running commands.

In E2B mode, an optional **auto-lint** pass runs after build to fix lint errors automatically.

All file changes in host mode are tracked by the rollback system and can be reversed via `POST /runs/:id/rollback`.

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
- **e2b** — Isolated [E2B](https://e2b.dev) sandbox with shell access via `sandbox_cmd` tool.

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
| `LANGSMITH_TRACING` | Enable LangSmith tracing (`true`) |
| `LANGSMITH_API_KEY` | LangSmith API key |

## Development

```bash
npm test                                        # Unit tests
npm test -- tests/unit/foo.test.ts              # Single file
npm test -- tests/unit/foo.test.ts -t "name"    # Single test
npm run test:encore                             # Integration tests
npm run typecheck                               # Type check
```

## License

Proprietary.
