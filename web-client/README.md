# Deployed API Web Client

Small static client for interacting with the deployed Platform Agent API.

## Run

```bash
cd web-client
python3 -m http.server 4173
# open http://localhost:4173
```

## What it does

- Calls `/v1/health` and `/v1/capabilities`
- Creates runs via `POST /v1/runs`
- Polls `GET /v1/runs/:id`, `/v1/runs/:id/events`, `/v1/runs/:id/artifacts`
- Supports both legacy and v1 response shapes (auto-unwraps `{ ok, data, meta }`)

Default base URL is set to the staging deployment:
`https://staging-platform-agent-3p2i.encr.app`
