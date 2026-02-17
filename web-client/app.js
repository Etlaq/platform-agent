const el = (id) => document.getElementById(id)

const apiBaseEl = el('apiBase')
const apiKeyEl = el('apiKey')
const promptEl = el('prompt')
const workspaceEl = el('workspaceBackend')
const providerEl = el('provider')
const modelEl = el('model')
const runIdEl = el('runId')
const outEl = el('output')

function log(obj) {
  const now = new Date().toISOString()
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  outEl.textContent = `[${now}]\n${line}\n\n${outEl.textContent}`
}

function readConfig() {
  const base = apiBaseEl.value.trim().replace(/\/$/, '')
  const key = apiKeyEl.value.trim()
  return { base, key }
}

async function api(path, options = {}) {
  const { base, key } = readConfig()
  const headers = new Headers(options.headers || {})
  if (key) headers.set('X-Agent-Api-Key', key)
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json')

  const res = await fetch(`${base}${path}`, {
    ...options,
    headers,
  })

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`)
  }

  if (json && typeof json === 'object' && 'ok' in json && 'data' in json) {
    if (json.ok === true) {
      return json.data
    }
    const message = typeof json.error?.message === 'string' ? json.error.message : 'API request failed'
    throw new Error(message)
  }

  return json
}

el('healthBtn').addEventListener('click', async () => {
  try {
    const data = await api('/v1/health')
    log({ endpoint: '/v1/health', data })
  } catch (err) {
    log(String(err))
  }
})

el('capBtn').addEventListener('click', async () => {
  try {
    const data = await api('/v1/capabilities')
    log({ endpoint: '/v1/capabilities', data })
  } catch (err) {
    log(String(err))
  }
})

el('createRunBtn').addEventListener('click', async () => {
  try {
    const body = {
      prompt: promptEl.value,
      workspaceBackend: workspaceEl.value,
      provider: providerEl.value || undefined,
      model: modelEl.value || undefined,
      stream: false,
    }
    const data = await api('/v1/runs', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (data?.id) runIdEl.value = data.id
    log({ endpoint: '/v1/runs', request: body, data })
  } catch (err) {
    log(String(err))
  }
})

el('pollBtn').addEventListener('click', async () => {
  const runId = runIdEl.value.trim()
  if (!runId) {
    log('Run ID is required')
    return
  }

  try {
    const [run, events, artifacts] = await Promise.all([
      api(`/v1/runs/${runId}`),
      api(`/v1/runs/${runId}/events`),
      api(`/v1/runs/${runId}/artifacts`),
    ])

    log({
      endpoint: `/v1/runs/${runId}`,
      run,
      recentEvents: Array.isArray(events) ? events.slice(-10) : events,
      artifacts,
    })
  } catch (err) {
    log(String(err))
  }
})
