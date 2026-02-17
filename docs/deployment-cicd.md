# Deployment CI/CD (GitHub -> Encore)

This document defines the deployment automation for this repository.

## What the pipeline does

Workflow file: `.github/workflows/ci-cd.yml`

1. On pull requests to `master`, run:
- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`

2. On pushes to `master`, run the same checks and then:
- request an OAuth token from Encore:
  - `POST https://api.encore.cloud/api/oauth/token`
- trigger rollout for the pushed SHA:
  - `POST https://api.encore.cloud/api/apps/{app_id}/envs/{env_name}/rollouts`
  - request body: `{"sha":"<commit-sha>"}`
- poll rollout status until completion:
  - `GET https://api.encore.cloud/api/apps/{app_id}/rollouts/{rollout_id}`

This gives deterministic deployment per commit instead of relying only on implicit branch triggers.

## Required GitHub secrets

Configure these in GitHub repository settings -> Secrets and variables -> Actions.

| Secret | Example | Notes |
|---|---|---|
| `ENCORE_APP_ID` | `platform-agent-3p2i` | Must match `encore.app` id |
| `ENCORE_ENV_NAME` | `staging` | Environment to deploy |
| `ENCORE_ACCESS_TOKEN` | `...` | Optional direct Encore bearer token; easiest to start, must be rotated |
| `ENCORE_CLIENT_ID` | `...` | OAuth client id from Encore (recommended long-term) |
| `ENCORE_CLIENT_SECRET` | `...` | OAuth client secret from Encore (recommended long-term) |

Authentication rule used by workflow:

- Use `ENCORE_ACCESS_TOKEN` if set.
- Otherwise use `ENCORE_CLIENT_ID` + `ENCORE_CLIENT_SECRET`.

## Required Encore secret

Configure in Encore environment secrets:

| Secret | Why |
|---|---|
| `AgentApiKey` | Declared by app infra; deploy fails without it |

Without `AgentApiKey`, Encore deploy fails during infrastructure validation with:
`failed to check secrets: secret key(s) not defined: AgentApiKey`.

## One-time setup checklist

1. Add `ENCORE_APP_ID` and `ENCORE_ENV_NAME`.
2. Add auth secret(s):
3. Option A: set `ENCORE_ACCESS_TOKEN` for immediate rollout capability.
4. Option B: create an Encore OAuth client and set `ENCORE_CLIENT_ID` + `ENCORE_CLIENT_SECRET`.
5. Set `AgentApiKey` in the target Encore environment (for example `staging`).
6. Push to `master`.
7. Confirm GitHub Action `CI/CD` succeeds.
8. Confirm rollout appears in Encore environment activity.

## Post-deploy verification

Use `/v1/*` endpoints for validation:

```bash
export API_BASE=https://staging-platform-agent-3p2i.encr.app
export AGENT_API_KEY=<key>

curl -s "$API_BASE/v1/health" | jq '.data.status,.meta.apiVersion'
curl -s -H "X-Agent-Api-Key: $AGENT_API_KEY" "$API_BASE/v1/workflows/status" | jq '.ok,.data.queue'
bun run api:check:smoke
```
