type HttpMethod = 'GET' | 'POST'

interface CheckOptions {
  mode: 'smoke' | 'deep'
  apiBase: string
  apiKey: string
  timeoutMs: number
  pollMs: number
}

interface RunSummary {
  id: string
  status: string
  output?: string | null
  error?: string | null
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: {
    code?: string
    message?: string
  }
  meta?: unknown
}

function parseArgValue(name: string) {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`))
  return direct ? direct.slice(name.length + 1) : null
}

function readOptions(): CheckOptions {
  const modeArg = parseArgValue('--mode') ?? process.argv[2] ?? 'smoke'
  const mode = modeArg === 'deep' ? 'deep' : 'smoke'

  const apiBase = (parseArgValue('--api') ?? process.env.API_BASE ?? 'http://localhost:4000').replace(/\/$/, '')
  const apiKey = parseArgValue('--key') ?? process.env.AGENT_API_KEY ?? process.env.API_KEY ?? ''
  const timeoutMs = Number(parseArgValue('--timeoutMs') ?? process.env.RUN_TIMEOUT_MS ?? 180_000)
  const pollMs = Number(parseArgValue('--pollMs') ?? process.env.RUN_POLL_MS ?? 2_000)

  if (!apiKey) {
    throw new Error('Missing API key. Set AGENT_API_KEY (or pass --key=...).')
  }

  return {
    mode,
    apiBase,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
    pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 2_000,
  }
}

function isEnvelope<T>(value: unknown): value is Envelope<T> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && ('data' in value || 'error' in value),
  )
}

async function request<T>(
  opts: CheckOptions,
  path: string,
  method: HttpMethod,
  body?: unknown,
): Promise<T> {
  const headers = new Headers()
  headers.set('X-Agent-Api-Key', opts.apiKey)
  if (body != null) headers.set('Content-Type', 'application/json')

  const res = await fetch(`${opts.apiBase}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  })

  const raw = await res.text()
  let parsed: unknown = raw
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // Preserve raw text for error surfaces.
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`)
  }

  if (isEnvelope<T>(parsed)) {
    if (parsed.ok === false) {
      throw new Error(`API ${path} failed: ${parsed.error?.message ?? 'unknown error'}`)
    }
    return parsed.data as T
  }

  return parsed as T
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function runChecks(opts: CheckOptions) {
  console.log(`[api-check] mode=${opts.mode} base=${opts.apiBase}`)

  const health = await request<{ status: string; ts: string }>(opts, '/v1/health', 'GET')
  console.log(`[api-check] health=${health.status} ts=${health.ts}`)

  const capabilities = await request<{ name: string; actions: string[] }>(opts, '/v1/capabilities', 'GET')
  console.log(`[api-check] capabilities name=${capabilities.name} actions=${capabilities.actions.length}`)

  const prompt = process.env.CHECK_PROMPT
    ?? 'Create a tiny text update and summarize changed files.'
  const createRun = await request<{ id: string; status: string }>(
    opts,
    '/v1/runs',
    'POST',
    {
      prompt,
      stream: false,
      workspaceBackend: process.env.CHECK_WORKSPACE_BACKEND ?? 'host',
      provider: process.env.CHECK_PROVIDER,
      model: process.env.CHECK_MODEL,
    },
  )

  const runId = createRun.id
  const deadline = Date.now() + opts.timeoutMs
  let summary: RunSummary | null = null

  while (Date.now() < deadline) {
    summary = await request<RunSummary>(opts, `/v1/runs/${runId}`, 'GET')
    console.log(`[api-check] run=${runId} status=${summary.status}`)
    if (summary.status === 'completed' || summary.status === 'error' || summary.status === 'cancelled') {
      break
    }
    await sleep(opts.pollMs)
  }

  if (!summary) {
    throw new Error(`Run ${runId} returned no summary.`)
  }

  if (summary.status !== 'completed') {
    throw new Error(`Run ${runId} ended in ${summary.status}: ${summary.error ?? 'no error text'}`)
  }

  if (opts.mode === 'deep') {
    const events = await request<Array<{ type?: string; event?: string; payload?: unknown }>>(
      opts,
      `/v1/runs/${runId}/events`,
      'GET',
    )
    const artifacts = await request<Array<{ name: string; path: string }>>(
      opts,
      `/v1/runs/${runId}/artifacts`,
      'GET',
    )

    const eventNames = events.map((evt) => evt.type ?? evt.event ?? '').filter(Boolean)
    const hasPlan = eventNames.includes('status')
    const hasDone = eventNames.includes('done')
    if (!hasPlan || !hasDone) {
      throw new Error(`Deep check failed for run ${runId}: expected status+done events, got [${eventNames.slice(-20).join(', ')}]`)
    }

    console.log(`[api-check] deep events=${events.length} artifacts=${artifacts.length}`)
  }

  console.log(`[api-check] success run=${runId}`)
}

async function main() {
  const opts = readOptions()
  await runChecks(opts)
}

main().catch((error) => {
  console.error(`[api-check] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
