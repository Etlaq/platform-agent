type HttpMethod = 'GET' | 'POST'

interface CheckOptions {
  mode: 'smoke' | 'deep'
  apiBase: string
  apiKey: string
  projectId: string
  timeoutMs: number
  pollMs: number
}

interface RunSummary {
  id: string
  projectId: string
  runIndex: number
  writable: boolean
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

interface CreateProjectMessageResponse {
  run: {
    id: string
    runIndex: number
    writable: boolean
  }
  message: {
    role: string
    content: string
    createdAt: string
  }
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
  const projectId = (parseArgValue('--projectId') ?? process.env.CHECK_PROJECT_ID ?? 'default').trim()
  const timeoutMs = Number(parseArgValue('--timeoutMs') ?? process.env.RUN_TIMEOUT_MS ?? 180_000)
  const pollMs = Number(parseArgValue('--pollMs') ?? process.env.RUN_POLL_MS ?? 2_000)

  if (!apiKey) {
    throw new Error('Missing API key. Set AGENT_API_KEY (or pass --key=...).')
  }
  if (!projectId) {
    throw new Error('Missing projectId. Set CHECK_PROJECT_ID (or pass --projectId=...).')
  }

  return {
    mode,
    apiBase,
    apiKey,
    projectId,
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
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers = new Headers()
  headers.set('X-Agent-Api-Key', opts.apiKey)
  if (body != null) headers.set('Content-Type', 'application/json')
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(key, value)
  }

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

function makeIdempotencyKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function waitForTerminalRun(opts: CheckOptions, projectId: string, runId: string) {
  const deadline = Date.now() + opts.timeoutMs
  let summary: RunSummary | null = null

  while (Date.now() < deadline) {
    summary = await request<RunSummary>(opts, `/v1/projects/${projectId}/runs/${runId}`, 'GET')
    console.log(`[api-check] run=${runId} index=${summary.runIndex} status=${summary.status} writable=${summary.writable}`)
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

  return summary
}

async function runChecks(opts: CheckOptions) {
  console.log(`[api-check] mode=${opts.mode} base=${opts.apiBase}`)

  const health = await request<{ status: string; ts: string }>(opts, '/v1/health', 'GET')
  console.log(`[api-check] health=${health.status} ts=${health.ts}`)

  const capabilities = await request<{ name: string; actions: string[] }>(opts, '/v1/capabilities', 'GET')
  console.log(`[api-check] capabilities name=${capabilities.name} actions=${capabilities.actions.length}`)

  const project = await request<{
    id: string
    name: string
    latestRunId: string | null
    created: boolean
  }>(
    opts,
    '/v1/projects',
    'POST',
    {
      id: opts.projectId,
      name: process.env.CHECK_PROJECT_NAME ?? `API Check ${opts.projectId}`,
    },
  )
  console.log(`[api-check] project id=${project.id} created=${project.created} latestRun=${project.latestRunId ?? 'none'}`)

  const prompt = process.env.CHECK_PROMPT
    ?? 'Create a tiny text update and summarize changed files.'
  const createRun = await request<{ id: string; status: string; runIndex: number; writable: boolean }>(
    opts,
    `/v1/projects/${opts.projectId}/runs`,
    'POST',
    {
      prompt,
      input: { check: opts.mode },
      stream: false,
      provider: process.env.CHECK_PROVIDER,
      model: process.env.CHECK_MODEL,
    },
    {
      'Idempotency-Key': makeIdempotencyKey('api-check-run'),
    },
  )

  const firstRunId = createRun.id
  const firstRunSummary = await waitForTerminalRun(opts, opts.projectId, firstRunId)

  if (opts.mode === 'deep') {
    const streamRes = await fetch(`${opts.apiBase}/v1/projects/${opts.projectId}/runs/${firstRunId}/stream`, {
      method: 'GET',
      headers: {
        'X-Agent-Api-Key': opts.apiKey,
      },
    })

    if (!streamRes.ok || !streamRes.body) {
      throw new Error(`Deep check failed: stream endpoint unavailable for run ${firstRunId}.`)
    }

    const reader = streamRes.body.getReader()
    let streamText = ''
    let lastEventId = 0
    for (let i = 0; i < 8; i++) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      streamText += new TextDecoder().decode(value)
      const idMatches = Array.from(streamText.matchAll(/^id:\s*(\d+)/gm))
      const maybeLastId = idMatches.length ? Number(idMatches[idMatches.length - 1]?.[1]) : NaN
      if (Number.isFinite(maybeLastId)) {
        lastEventId = Math.max(lastEventId, maybeLastId)
      }
      if (streamText.includes('event: done') || streamText.includes('event: error')) {
        break
      }
    }
    reader.releaseLock()

    if (!streamText.includes('event:')) {
      throw new Error(`Deep check failed: stream produced no events for run ${firstRunId}.`)
    }

    const replayRes = await fetch(`${opts.apiBase}/v1/projects/${opts.projectId}/runs/${firstRunId}/stream`, {
      method: 'GET',
      headers: {
        'X-Agent-Api-Key': opts.apiKey,
        'Last-Event-ID': String(lastEventId),
      },
    })
    if (!replayRes.ok) {
      throw new Error(`Deep check failed: replay stream failed for run ${firstRunId}.`)
    }
    replayRes.body?.cancel().catch(() => undefined)

    const downloadRes = await fetch(`${opts.apiBase}/v1/projects/${opts.projectId}/runs/${firstRunId}/download.zip`, {
      method: 'GET',
      headers: {
        'X-Agent-Api-Key': opts.apiKey,
      },
    })
    if (!downloadRes.ok) {
      throw new Error(`Deep check failed: run zip download failed for run ${firstRunId}.`)
    }

    const secondRunEnvelope = await request<CreateProjectMessageResponse>(
      opts,
      `/v1/projects/${opts.projectId}/messages`,
      'POST',
      {
        content: process.env.CHECK_FOLLOWUP_PROMPT ?? 'Now refine the output and include a concise implementation checklist.',
        input: { sourceRunId: firstRunId },
        stream: false,
        provider: process.env.CHECK_PROVIDER,
        model: process.env.CHECK_MODEL,
      },
      {
        'Idempotency-Key': makeIdempotencyKey('api-check-msg'),
      },
    )
    const secondRun = secondRunEnvelope.run

    const secondRunSummary = await waitForTerminalRun(opts, opts.projectId, secondRun.id)

    const firstRunAfterSecond = await request<RunSummary>(opts, `/v1/projects/${opts.projectId}/runs/${firstRunId}`, 'GET')
    if (firstRunAfterSecond.writable) {
      throw new Error('Deep check failed: previous run remained writable after new run creation.')
    }
    if (!secondRunSummary.writable) {
      throw new Error('Deep check failed: newest run is not marked writable.')
    }

    const messages = await request<Array<{ id: number; role: string; content: string }>>(
      opts,
      `/v1/projects/${opts.projectId}/runs/${secondRun.id}/messages`,
      'GET',
    )

    if (messages.length === 0) {
      throw new Error('Deep check failed: run messages endpoint returned no messages.')
    }

    console.log(
      `[api-check] deep replay_from=${lastEventId} zip_status=${downloadRes.status} stream_bytes=${streamText.length} firstRunIndex=${firstRunSummary.runIndex} secondRunIndex=${secondRunSummary.runIndex}`,
    )
  }

  console.log(`[api-check] success run=${firstRunId}`)
}

async function main() {
  const opts = readOptions()
  await runChecks(opts)
}

main().catch((error) => {
  console.error(`[api-check] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
