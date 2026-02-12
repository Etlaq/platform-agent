export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled'

export interface RunEvent {
  id: number
  event: 'status' | 'token' | 'tool' | 'done' | 'error'
  data: unknown
  ts: string
}

export interface RunRecord {
  id: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  prompt: string
  input?: unknown
  provider?: string
  model?: string
  sandboxId?: string
  nextjsUrl?: string
  downloadPath?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  durationMs?: number
  output?: string
  error?: string
  events: RunEvent[]
  completion?: Promise<string>
  abortController?: AbortController
  subscribers: Set<(event: RunEvent) => void>
  nextEventId: number
}

const runs = new Map<string, RunRecord>()
const MAX_EVENTS = 500

function parsePositiveInt(name: string, fallback: number, opts?: { min?: number; max?: number }) {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  const min = opts?.min ?? 1
  const max = opts?.max ?? Number.MAX_SAFE_INTEGER
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

const MAX_MEM_RUNS = parsePositiveInt('MAX_MEM_RUNS', 200, { min: 10, max: 10_000 })
const MEM_RUN_TTL_MS = parsePositiveInt('MEM_RUN_TTL_MS', 6 * 60 * 60 * 1000, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 })

function pruneRuns() {
  if (runs.size <= MAX_MEM_RUNS) return
  const now = Date.now()
  const terminal: Array<{ id: string; updatedAt: number }> = []
  for (const r of runs.values()) {
    const isTerminal = r.status === 'completed' || r.status === 'error' || r.status === 'cancelled'
    if (!isTerminal) continue
    const t = Date.parse(r.updatedAt)
    if (!Number.isFinite(t)) continue
    if (now - t < MEM_RUN_TTL_MS) continue
    terminal.push({ id: r.id, updatedAt: t })
  }
  terminal.sort((a, b) => a.updatedAt - b.updatedAt)
  for (const r of terminal) {
    if (runs.size <= MAX_MEM_RUNS) break
    runs.delete(r.id)
  }
}

export function createRun(params: {
  prompt: string
  input?: unknown
  provider?: string
  model?: string
}): RunRecord {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  const run: RunRecord = {
    id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    prompt: params.prompt,
    input: params.input,
    provider: params.provider,
    model: params.model,
    events: [],
    subscribers: new Set(),
    nextEventId: 1,
  }

  runs.set(id, run)
  pruneRuns()
  emitEvent(run, 'status', { status: 'queued' })
  return run
}

export function getRun(id: string): RunRecord | undefined {
  return runs.get(id)
}

export function listRuns(): RunRecord[] {
  return Array.from(runs.values())
}

export function emitEvent(run: RunRecord, event: RunEvent['event'], data: unknown) {
  const record: RunEvent = {
    id: run.nextEventId++,
    event,
    data,
    ts: new Date().toISOString(),
  }

  run.events.push(record)
  if (run.events.length > MAX_EVENTS) {
    run.events.splice(0, run.events.length - MAX_EVENTS)
  }
  run.updatedAt = record.ts

  run.subscribers.forEach((subscriber) => {
    subscriber(record)
  })
}

export function subscribe(run: RunRecord, listener: (event: RunEvent) => void) {
  run.subscribers.add(listener)
  return () => {
    run.subscribers.delete(listener)
  }
}

export function startRun(
  run: RunRecord,
  executor: () => Promise<string>
): Promise<string> {
  run.status = 'running'
  emitEvent(run, 'status', { status: 'running' })

  const completion = executor()
    .then((output) => {
      // Cancellation is terminal. Don't overwrite it when the executor finishes.
      if (run.status !== 'cancelled') {
        run.status = 'completed'
        run.output = output
        emitEvent(run, 'done', { output })
      }
      return output
    })
    .catch((error: unknown) => {
      // Cancellation is terminal. Don't overwrite it when the executor fails.
      if (run.status !== 'cancelled') {
        run.status = 'error'
        run.error = error instanceof Error ? error.message : String(error)
        emitEvent(run, 'error', { error: run.error })
      }
      throw error
    })

  run.completion = completion
  return completion
}

export function cancelRun(run: RunRecord) {
  run.abortController?.abort('run_cancelled')
  run.status = 'cancelled'
  emitEvent(run, 'status', { status: 'cancelled' })
}
