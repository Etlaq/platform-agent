# agent_v2

Encore-based rewrite of the agent control plane, rebuilt from scratch in a dedicated subfolder using `encore app create`.

## Create (CLI)

```bash
encore app create agent-v2 --lang ts --platform=false
```

This repository keeps that generated app at:

```bash
agent_v2/
```

## Run

```bash
cd agent_v2
bun install
encore run
```

## Verify

```bash
bun run typecheck
encore test
```

## Service Layout

- `control/`:
  - public root, health, capabilities endpoints
- `auth/`:
  - API-key auth gateway (`X-Agent-Api-Key`)
- `runs/`:
  - run lifecycle endpoints, SSE stream, events, artifacts, rollback APIs
- `worker/`:
  - Pub/Sub run processor + stale-run cron requeue
- `data/`:
  - SQL schema + DB access functions
- `storage/`:
  - rollback manifest sync/read via object storage
- `sandbox/`:
  - `/exec` and `/sandbox/*` APIs
- `download/`:
  - host and sandbox zip download endpoints
- `metrics/`:
  - plaintext metrics endpoint
- `agent/`:
  - runtime engine, provider/model logic, tools, path policy, rollback manager

## Run Phases

Each `/runs` prompt is processed in two phases:

1. Plan phase (read-only intent): the agent inspects the workspace and emits a structured plan + todo list.
2. Build phase (execution): the agent implements the approved todos and returns final output.

Phase progress is streamed via run SSE status events (`phase_started`, `plan_ready`, `phase_transition`, `phase_completed`).

## Env (minimum)

- `AGENT_API_KEY`: required for authenticated control-plane endpoints
- At least one model key:
  - `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` or `XAI_API_KEY` or `ZAI_API_KEY`
- Optional LangSmith tracing:
  - `LANGSMITH_TRACING=true` (or `LANGSMITH_TRACING_V2=true`)
  - `LANGSMITH_API_KEY`
  - optional `LANGSMITH_PROJECT`, `LANGSMITH_ENDPOINT`, `LANGSMITH_WORKSPACE_ID`
- Optional sandbox support:
  - `E2B_API_KEY`
  - `E2B_TEMPLATE`
