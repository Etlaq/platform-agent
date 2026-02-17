import { SQLDatabase } from 'encore.dev/storage/sqldb'

export type RunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface RunRecord {
  id: string
  projectId: string
  idempotencyKey: string | null
  status: RunStatus
  prompt: string
  input: unknown | null
  provider: string | null
  model: string | null
  modelSource: string | null
  workspaceBackend: 'host' | 'e2b' | null
  output: string | null
  error: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
  durationMs: number | null
  attempt: number
  maxAttempts: number
  sandboxId: string | null
  estimatedCostUsd: number | null
  costCurrency: string | null
  pricingVersion: string | null
  startedAt: string | null
  completedAt: string | null
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
  project_id: string
  idempotency_key: string | null
  status: RunStatus
  prompt: string
  input: unknown | null
  provider: string | null
  model: string | null
  model_source: string | null
  workspace_backend: 'host' | 'e2b' | null
  output: string | null
  error: string | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cached_input_tokens: number | null
  reasoning_output_tokens: number | null
  duration_ms: number | null
  attempt: number
  max_attempts: number
  sandbox_id: string | null
  estimated_cost_usd: number | string | null
  cost_currency: string | null
  pricing_version: string | null
  started_at: Date | string | null
  completed_at: Date | string | null
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

interface PricingRow {
  currency: string
  input_cost_per_1k: number | string
  output_cost_per_1k: number | string
  cached_input_cost_per_1k: number | string
  reasoning_output_cost_per_1k: number | string
  pricing_version: string
}

interface PricingSpec {
  currency: string
  inputCostPer1k: number
  outputCostPer1k: number
  cachedInputCostPer1k: number
  reasoningOutputCostPer1k: number
  pricingVersion: string
}

const UNIQUE_VIOLATION = '23505'

export const db = new SQLDatabase('agent', {
  migrations: './migrations',
})

function toIsoString(value: Date | string) {
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

function toMaybeIsoString(value: Date | string | null) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

function toFiniteNumber(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key ?? null,
    status: row.status,
    prompt: row.prompt,
    input: row.input ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    modelSource: row.model_source ?? null,
    workspaceBackend: row.workspace_backend ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    totalTokens: row.total_tokens ?? null,
    cachedInputTokens: row.cached_input_tokens ?? null,
    reasoningOutputTokens: row.reasoning_output_tokens ?? null,
    durationMs: row.duration_ms ?? null,
    attempt: row.attempt ?? 0,
    maxAttempts: row.max_attempts ?? 0,
    sandboxId: row.sandbox_id ?? null,
    estimatedCostUsd: toFiniteNumber(row.estimated_cost_usd),
    costCurrency: row.cost_currency ?? null,
    pricingVersion: row.pricing_version ?? null,
    startedAt: toMaybeIsoString(row.started_at),
    completedAt: toMaybeIsoString(row.completed_at),
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

function normalizeLookup(value: string) {
  return value.trim().toLowerCase()
}

function mapPricingRow(row: PricingRow): PricingSpec {
  return {
    currency: row.currency,
    inputCostPer1k: Number(row.input_cost_per_1k) || 0,
    outputCostPer1k: Number(row.output_cost_per_1k) || 0,
    cachedInputCostPer1k: Number(row.cached_input_cost_per_1k) || 0,
    reasoningOutputCostPer1k: Number(row.reasoning_output_cost_per_1k) || 0,
    pricingVersion: row.pricing_version,
  }
}

async function resolvePricing(provider: string, model: string): Promise<PricingSpec | null> {
  const normalizedProvider = normalizeLookup(provider)
  const normalizedModel = normalizeLookup(model)
  if (!normalizedProvider || !normalizedModel) return null

  const row = await db.queryRow<PricingRow>`
    SELECT currency, input_cost_per_1k, output_cost_per_1k, cached_input_cost_per_1k, reasoning_output_cost_per_1k, pricing_version
    FROM model_pricing
    WHERE active = TRUE
      AND lower(provider) = ${normalizedProvider}
      AND lower(model) = ${normalizedModel}
    ORDER BY updated_at DESC
    LIMIT 1
  `

  if (row) return mapPricingRow(row)
  return null
}

async function estimateCostUsd(meta: {
  provider?: string
  model?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}) {
  // Cost estimates are computed only from provider-reported response usage metadata.
  if (!meta.provider || !meta.model || !meta.usage) {
    return {
      estimatedCostUsd: null as number | null,
      costCurrency: null as string | null,
      pricingVersion: null as string | null,
    }
  }

  const pricing = await resolvePricing(meta.provider, meta.model)
  if (!pricing) {
    return {
      estimatedCostUsd: null as number | null,
      costCurrency: null as string | null,
      pricingVersion: null as string | null,
    }
  }

  const inputTokens = Math.max(0, Number(meta.usage.inputTokens) || 0)
  const outputTokens = Math.max(0, Number(meta.usage.outputTokens) || 0)
  const cachedInputTokens = Math.max(0, Number(meta.cachedInputTokens) || 0)
  const reasoningOutputTokens = Math.max(0, Number(meta.reasoningOutputTokens) || 0)

  const usd = (
    (inputTokens * pricing.inputCostPer1k) +
    (outputTokens * pricing.outputCostPer1k) +
    (cachedInputTokens * pricing.cachedInputCostPer1k) +
    (reasoningOutputTokens * pricing.reasoningOutputCostPer1k)
  ) / 1000

  return {
    estimatedCostUsd: Number(usd.toFixed(8)),
    costCurrency: pricing.currency,
    pricingVersion: pricing.pricingVersion,
  }
}

export function resolveMaxJobAttempts() {
  const raw = process.env.MAX_JOB_ATTEMPTS
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(20, Math.trunc(n)))
}

export function resolveWorkerKickQueuedLimit() {
  const raw = process.env.WORKER_KICK_QUEUED_LIMIT
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 50
  return Math.max(1, Math.min(500, Math.trunc(n)))
}

export function resolveWorkerKickQueuedMinAgeSeconds() {
  const raw = process.env.WORKER_KICK_QUEUED_MIN_AGE_S
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 30
  return Math.max(0, Math.min(86_400, Math.trunc(n)))
}

export function resolveRequeueRunningAfterSeconds() {
  const raw = process.env.WORKER_REQUEUE_RUNNING_AFTER_S
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(86_400, Math.trunc(n)))
}

export async function getRunByProjectIdempotency(projectId: string, idempotencyKey: string) {
  const row = await db.queryRow<RunRow>`
    SELECT *
    FROM runs
    WHERE project_id = ${projectId}
      AND idempotency_key = ${idempotencyKey}
  `
  if (!row) return null
  return toRunRecord(row)
}

export async function createQueuedRun(params: {
  id: string
  projectId: string
  idempotencyKey: string
  prompt: string
  input?: unknown
  provider?: string
  model?: string
  workspaceBackend?: 'host' | 'e2b'
  maxAttempts?: number
}) {
  const maxAttempts = params.maxAttempts ?? resolveMaxJobAttempts()
  const tx = await db.begin()
  try {
    const inserted = await tx.queryRow<RunRow>`
      INSERT INTO runs (
        id,
        project_id,
        idempotency_key,
        status,
        prompt,
        input,
        provider,
        model,
        workspace_backend,
        max_attempts,
        attempt
      )
      VALUES (
        ${params.id},
        ${params.projectId},
        ${params.idempotencyKey},
        'queued',
        ${params.prompt},
        ${params.input ?? null}::jsonb,
        ${params.provider ?? null},
        ${params.model ?? null},
        ${params.workspaceBackend ?? null},
        ${maxAttempts},
        0
      )
      ON CONFLICT (project_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING *
    `

    if (!inserted) {
      const existing = await tx.queryRow<RunRow>`
        SELECT *
        FROM runs
        WHERE project_id = ${params.projectId}
          AND idempotency_key = ${params.idempotencyKey}
      `
      await tx.commit()

      if (!existing) {
        throw new Error('idempotency_conflict_without_existing_run')
      }

      return {
        run: toRunRecord(existing),
        created: false,
      }
    }

    await tx.exec`
      INSERT INTO events (run_id, seq, type, payload)
      VALUES (${params.id}, 1, 'status', ${stringifyPayload({ status: 'queued' })}::jsonb)
    `

    await tx.exec`
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

    await tx.commit()

    return {
      run: toRunRecord(inserted),
      created: true,
    }
  } catch (error) {
    await tx.rollback().catch(() => undefined)

    if (isUniqueViolation(error)) {
      const existing = await getRunByProjectIdempotency(params.projectId, params.idempotencyKey)
      if (existing) {
        return {
          run: existing,
          created: false,
        }
      }
    }

    throw error
  }
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

export async function setRunExecutionAttempt(runId: string, attempt: number, maxAttempts: number) {
  await db.exec`
    UPDATE runs
    SET attempt = ${Math.max(0, Math.trunc(attempt))},
        max_attempts = ${Math.max(1, Math.trunc(maxAttempts))},
        started_at = COALESCE(started_at, NOW()),
        completed_at = NULL,
        updated_at = NOW()
    WHERE id = ${runId}
  `
}

export async function setRunSandboxId(runId: string, sandboxId: string | null) {
  await db.exec`
    UPDATE runs
    SET sandbox_id = ${sandboxId},
        updated_at = NOW()
    WHERE id = ${runId}
  `
}

export async function updateRunStatus(id: string, status: RunStatus) {
  await db.exec`
    UPDATE runs
    SET status = ${status},
        started_at = CASE
          WHEN ${status} = 'running' THEN COALESCE(started_at, NOW())
          ELSE started_at
        END,
        completed_at = CASE
          WHEN ${status} IN ('completed', 'error', 'cancelled') THEN COALESCE(completed_at, NOW())
          WHEN ${status} = 'queued' THEN NULL
          ELSE completed_at
        END,
        updated_at = NOW()
    WHERE id = ${id}
      AND (
        (${status} = 'running' AND status IN ('queued', 'running'))
        OR (${status} = 'queued' AND status IN ('running', 'queued'))
        OR (${status} = 'cancelled' AND status IN ('queued', 'running', 'cancelled'))
        OR (${status} = status)
      )
  `
}

export async function claimRunForExecution(runId: string) {
  const row = await db.queryRow<{ id: string }>`
    WITH eligible AS (
      SELECT r.id
      FROM runs r
      JOIN jobs j ON j.run_id = r.id
      WHERE r.id = ${runId}
        AND r.status IN ('queued', 'running')
        AND j.status = 'queued'
        AND j.next_run_at <= NOW()
      FOR UPDATE
    ),
    claimed_run AS (
      UPDATE runs
      SET status = 'running', updated_at = NOW(), started_at = COALESCE(started_at, NOW()), completed_at = NULL
      WHERE id IN (
        SELECT id
        FROM eligible
      )
      RETURNING id
    ),
    claimed_job AS (
      UPDATE jobs
      SET status = 'running', updated_at = NOW()
      WHERE run_id IN (
        SELECT id
        FROM claimed_run
      )
        AND status = 'queued'
      RETURNING run_id
    )
    SELECT id
    FROM claimed_run
    WHERE EXISTS (
      SELECT 1
      FROM claimed_job
    )
  `

  return Boolean(row)
}

export async function listRunnableQueuedJobRunIds(params?: {
  limit?: number
  minQueuedAgeSeconds?: number
}) {
  const limit = Math.max(1, Math.min(500, Math.trunc(params?.limit ?? 50)))
  const minAgeSeconds = Math.max(0, Math.min(86_400, Math.trunc(params?.minQueuedAgeSeconds ?? 30)))

  const rows = await db.query<{ run_id: string }>`
    SELECT run_id
    FROM jobs
    WHERE status = 'queued'
      AND next_run_at <= NOW()
      AND updated_at < NOW() - (${minAgeSeconds} || ' seconds')::interval
    ORDER BY updated_at ASC
    LIMIT ${limit}
  `

  const queued = await collectRows(rows)
  return queued.map((row) => row.run_id)
}

export async function countRunnableQueuedJobs(params?: {
  minQueuedAgeSeconds?: number
}) {
  const minAgeSeconds = Math.max(0, Math.min(86_400, Math.trunc(params?.minQueuedAgeSeconds ?? 0)))
  const row = await db.queryRow<{ count: number }>`
    SELECT COUNT(*)::int as count
    FROM jobs
    WHERE status = 'queued'
      AND next_run_at <= NOW()
      AND updated_at < NOW() - (${minAgeSeconds} || ' seconds')::interval
  `
  return row?.count ?? 0
}

export async function countStaleRunningJobs(staleSeconds: number) {
  const safeStaleSeconds = Math.max(0, Math.min(86_400, Math.trunc(staleSeconds)))
  if (safeStaleSeconds <= 0) return 0

  const row = await db.queryRow<{ count: number }>`
    SELECT COUNT(*)::int as count
    FROM jobs
    WHERE status = 'running'
      AND updated_at < NOW() - (${safeStaleSeconds} || ' seconds')::interval
  `
  return row?.count ?? 0
}

export async function completeRun(id: string, output: string, meta?: {
  provider?: string
  model?: string
  modelSource?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  cachedInputTokens?: number
  reasoningOutputTokens?: number
  durationMs?: number
}) {
  const provider = meta?.provider ?? null
  const model = meta?.model ?? null
  const modelSource = meta?.modelSource ?? null
  const inputTokens = meta?.usage?.inputTokens ?? null
  const outputTokens = meta?.usage?.outputTokens ?? null
  const totalTokens = meta?.usage?.totalTokens ?? null
  const cachedInputTokens = meta?.cachedInputTokens ?? null
  const reasoningOutputTokens = meta?.reasoningOutputTokens ?? null
  const durationMs = meta?.durationMs ?? null

  const estimated = await estimateCostUsd({
    provider: provider ?? undefined,
    model: model ?? undefined,
    usage: meta?.usage,
    cachedInputTokens: cachedInputTokens ?? undefined,
    reasoningOutputTokens: reasoningOutputTokens ?? undefined,
  })

  await db.exec`
    UPDATE runs
    SET status = 'completed',
        output = ${output},
        provider = COALESCE(${provider}, provider),
        model = COALESCE(${model}, model),
        model_source = COALESCE(${modelSource}, model_source),
        input_tokens = ${inputTokens},
        output_tokens = ${outputTokens},
        total_tokens = ${totalTokens},
        cached_input_tokens = ${cachedInputTokens},
        reasoning_output_tokens = ${reasoningOutputTokens},
        duration_ms = ${durationMs},
        estimated_cost_usd = COALESCE(${estimated.estimatedCostUsd}, estimated_cost_usd),
        cost_currency = COALESCE(${estimated.costCurrency}, cost_currency),
        pricing_version = COALESCE(${estimated.pricingVersion}, pricing_version),
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `
}

export async function updateRunMeta(id: string, meta: {
  provider?: string
  model?: string
  modelSource?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  cachedInputTokens?: number
  reasoningOutputTokens?: number
  durationMs?: number
}) {
  const provider = meta.provider ?? null
  const model = meta.model ?? null
  const modelSource = meta.modelSource ?? null
  const inputTokens = meta.usage?.inputTokens ?? null
  const outputTokens = meta.usage?.outputTokens ?? null
  const totalTokens = meta.usage?.totalTokens ?? null
  const cachedInputTokens = meta.cachedInputTokens ?? null
  const reasoningOutputTokens = meta.reasoningOutputTokens ?? null
  const durationMs = meta.durationMs ?? null

  await db.exec`
    UPDATE runs
    SET provider = COALESCE(${provider}, provider),
        model = COALESCE(${model}, model),
        model_source = COALESCE(${modelSource}, model_source),
        input_tokens = COALESCE(${inputTokens}, input_tokens),
        output_tokens = COALESCE(${outputTokens}, output_tokens),
        total_tokens = COALESCE(${totalTokens}, total_tokens),
        cached_input_tokens = COALESCE(${cachedInputTokens}, cached_input_tokens),
        reasoning_output_tokens = COALESCE(${reasoningOutputTokens}, reasoning_output_tokens),
        duration_ms = COALESCE(${durationMs}, duration_ms),
        updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function failRun(id: string, error: string) {
  await db.exec`
    UPDATE runs
    SET status = 'error', error = ${error}, completed_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND status = 'running'
  `
}

export async function cancelRun(id: string) {
  await db.exec`
    UPDATE runs
    SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
    WHERE id = ${id}
      AND status IN ('queued', 'running', 'cancelled')
  `
}

export async function queueRunForRetry(id: string) {
  await db.exec`
    UPDATE runs
    SET status = 'queued', completed_at = NULL, updated_at = NOW()
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
