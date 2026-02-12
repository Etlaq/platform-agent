import { SQLDatabase } from 'encore.dev/storage/sqldb'

export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface RunRecord {
  id: string
  status: RunStatus
  prompt: string
  input: unknown | null
  provider: string | null
  model: string | null
  workspaceBackend: 'host' | 'e2b' | null
  output: string | null
  error: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

export interface EventRecord {
  id: number
  seq: number
  type: string
  payload: unknown
  ts: string
}

interface RunRow {
  id: string
  status: RunStatus
  prompt: string
  input: unknown | null
  provider: string | null
  model: string | null
  workspace_backend: 'host' | 'e2b' | null
  output: string | null
  error: string | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  duration_ms: number | null
  created_at: Date | string
  updated_at: Date | string
}

interface EventRow {
  id: number
  seq: number
  type: string
  payload: unknown
  ts: Date | string
}

interface JobRow {
  id: number
  run_id: string
  status: JobStatus
  attempts: number
  max_attempts: number
  next_run_at: Date | string
  updated_at: Date | string
}

const UNIQUE_VIOLATION = '23505'

export const db = new SQLDatabase('agent', {
  migrations: './migrations',
})

function toIsoString(value: Date | string) {
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    status: row.status,
    prompt: row.prompt,
    input: row.input ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    workspaceBackend: row.workspace_backend ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    durationMs: row.duration_ms ?? null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    payload: row.payload ?? null,
    ts: toIsoString(row.ts),
  }
}

function normalizeJsonPayload(payload: unknown) {
  if (payload == null) return null
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload)
    } catch {
      return payload
    }
  }
  return payload
}

function stringifyPayload(payload: unknown) {
  return JSON.stringify(payload ?? null)
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const maybe = error as { code?: unknown }
  return maybe.code === UNIQUE_VIOLATION
}

async function collectRows<T>(iterable: AsyncIterable<T>) {
  const rows: T[] = []
  for await (const row of iterable) {
    rows.push(row)
  }
  return rows
}

export function resolveMaxJobAttempts() {
  const raw = process.env.MAX_JOB_ATTEMPTS
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(20, Math.trunc(n)))
}

export function resolveRequeueRunningAfterSeconds() {
  const raw = process.env.WORKER_REQUEUE_RUNNING_AFTER_S
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(86_400, Math.trunc(n)))
}

export async function createQueuedRun(params: {
  id: string
  prompt: string
  input?: unknown
  provider?: string
  model?: string
  workspaceBackend?: 'host' | 'e2b'
  maxAttempts?: number
}) {
  const maxAttempts = params.maxAttempts ?? resolveMaxJobAttempts()

  await db.exec`
    INSERT INTO runs (id, status, prompt, input, provider, model, workspace_backend)
    VALUES (${params.id}, 'queued', ${params.prompt}, ${params.input ?? null}::jsonb, ${params.provider ?? null}, ${params.model ?? null}, ${params.workspaceBackend ?? null})
  `

  await db.exec`
    INSERT INTO events (run_id, seq, type, payload)
    VALUES (${params.id}, 1, 'status', ${stringifyPayload({ status: 'queued' })}::jsonb)
  `

  await db.exec`
    INSERT INTO jobs (run_id, status, max_attempts)
    VALUES (${params.id}, 'queued', ${maxAttempts})
    ON CONFLICT (run_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      attempts = 0,
      max_attempts = EXCLUDED.max_attempts,
      next_run_at = NOW(),
      updated_at = NOW()
  `
}

export async function listRuns(limit = 50, offset = 0) {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  const safeOffset = Math.max(0, Math.trunc(offset))
  const rows = await db.query<RunRow>`
    SELECT *
    FROM runs
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
    OFFSET ${safeOffset}
  `
  return (await collectRows(rows)).map(toRunRecord)
}

export async function getRun(id: string) {
  const row = await db.queryRow<RunRow>`
    SELECT *
    FROM runs
    WHERE id = ${id}
  `
  if (!row) return null
  return toRunRecord(row)
}

export async function updateRunStatus(id: string, status: RunStatus) {
  await db.exec`
    UPDATE runs
    SET status = ${status}, updated_at = NOW()
    WHERE id = ${id}
      AND (
        (${status} = 'running' AND status IN ('queued', 'running'))
        OR (${status} = 'queued' AND status IN ('running', 'queued'))
        OR (${status} = 'cancelled' AND status IN ('queued', 'running', 'cancelled'))
        OR (${status} = status)
      )
  `
}

export async function completeRun(id: string, output: string, meta?: {
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  durationMs?: number
}) {
  const inputTokens = meta?.usage?.inputTokens ?? null
  const outputTokens = meta?.usage?.outputTokens ?? null
  const totalTokens = meta?.usage?.totalTokens ?? null
  const durationMs = meta?.durationMs ?? null
  await db.exec`
    UPDATE runs
    SET status = 'completed',
        output = ${output},
        input_tokens = ${inputTokens},
        output_tokens = ${outputTokens},
        total_tokens = ${totalTokens},
        duration_ms = ${durationMs},
        updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `
}

export async function failRun(id: string, error: string) {
  await db.exec`
    UPDATE runs
    SET status = 'error', error = ${error}, updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `
}

export async function cancelRun(id: string) {
  await db.exec`
    UPDATE runs
    SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${id}
      AND status IN ('queued', 'running', 'cancelled')
  `
}

export async function queueRunForRetry(id: string) {
  await db.exec`
    UPDATE runs
    SET status = 'queued', updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `
}

export async function insertEventWithNextSeq(params: {
  runId: string
  type: string
  payload: unknown
  maxRetries?: number
}) {
  const retries = Math.max(0, Math.trunc(params.maxRetries ?? 5))
  const payload = stringifyPayload(params.payload)

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await db.exec`
        INSERT INTO events (run_id, seq, type, payload)
        SELECT
          ${params.runId},
          COALESCE(MAX(seq), 0) + 1,
          ${params.type},
          ${payload}::jsonb
        FROM events
        WHERE run_id = ${params.runId}
      `
      return
    } catch (error) {
      if (attempt < retries && isUniqueViolation(error)) {
        continue
      }
      throw error
    }
  }

  throw new Error('failed_to_insert_event_after_retries')
}

export async function listEvents(runId: string) {
  const rows = await db.query<EventRow>`
    SELECT id, seq, type, payload, ts
    FROM events
    WHERE run_id = ${runId}
    ORDER BY id ASC
  `
  return (await collectRows(rows)).map((row) => {
    const shaped = toEventRecord(row)
    return { ...shaped, payload: normalizeJsonPayload(shaped.payload) }
  })
}

export async function listEventsAfter(runId: string, afterId: number) {
  const rows = await db.query<EventRow>`
    SELECT id, seq, type, payload, ts
    FROM events
    WHERE run_id = ${runId} AND id > ${afterId}
    ORDER BY id ASC
  `
  return (await collectRows(rows)).map((row) => {
    const shaped = toEventRecord(row)
    return { ...shaped, payload: normalizeJsonPayload(shaped.payload) }
  })
}

export async function listArtifacts(runId: string) {
  const rows = await db.query<{
    id: number
    name: string
    path: string
    mime: string | null
    size: number | null
    created_at: Date | string
  }>`
    SELECT id, name, path, mime, size, created_at
    FROM artifacts
    WHERE run_id = ${runId}
    ORDER BY id ASC
  `

  const artifacts = await collectRows(rows)
  return artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    path: artifact.path,
    mime: artifact.mime,
    size: artifact.size,
    createdAt: toIsoString(artifact.created_at),
  }))
}

export async function addArtifact(params: {
  runId: string
  name: string
  path: string
  mime?: string
  size?: number
}) {
  await db.exec`
    INSERT INTO artifacts (run_id, name, path, mime, size)
    VALUES (${params.runId}, ${params.name}, ${params.path}, ${params.mime ?? null}, ${params.size ?? null})
  `
}

export async function getJobByRunId(runId: string) {
  const row = await db.queryRow<JobRow>`
    SELECT id, run_id, status, attempts, max_attempts, next_run_at, updated_at
    FROM jobs
    WHERE run_id = ${runId}
  `
  if (!row) return null
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRunAt: toIsoString(row.next_run_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

export async function setJobStatus(runId: string, status: JobStatus) {
  await db.exec`
    UPDATE jobs
    SET status = ${status}, updated_at = NOW()
    WHERE run_id = ${runId}
  `
}

export async function markJobFailed(runId: string, attempts: number, delaySeconds: number) {
  await db.exec`
    UPDATE jobs
    SET
      status = CASE WHEN ${attempts} >= max_attempts THEN 'failed' ELSE 'queued' END,
      attempts = ${attempts},
      next_run_at = NOW() + (${delaySeconds} || ' seconds')::interval,
      updated_at = NOW()
    WHERE run_id = ${runId}
  `
}

export async function cancelJobByRunId(runId: string) {
  await db.exec`
    UPDATE jobs
    SET status = 'cancelled', updated_at = NOW()
    WHERE run_id = ${runId}
  `
}

export async function getRunsStatusCounts() {
  const rows = await db.query<{ status: string; count: number }>`
    SELECT status, COUNT(*)::int as count
    FROM runs
    GROUP BY status
  `
  return collectRows(rows)
}

export async function getJobsStatusCounts() {
  const rows = await db.query<{ status: string; count: number }>`
    SELECT status, COUNT(*)::int as count
    FROM jobs
    GROUP BY status
  `
  return collectRows(rows)
}

export async function requeueStaleRunningJobs(staleSeconds: number) {
  if (staleSeconds <= 0) return [] as string[]

  const rows = await db.query<{ run_id: string }>`
    SELECT run_id
    FROM jobs
    WHERE status = 'running'
      AND updated_at < NOW() - (${staleSeconds} || ' seconds')::interval
  `
  const stale = await collectRows(rows)
  const runIds = stale.map((row) => row.run_id)

  if (runIds.length === 0) return runIds

  await db.exec`
    UPDATE jobs
    SET status = 'queued', next_run_at = NOW(), updated_at = NOW()
    WHERE status = 'running'
      AND updated_at < NOW() - (${staleSeconds} || ' seconds')::interval
  `

  return runIds
}
