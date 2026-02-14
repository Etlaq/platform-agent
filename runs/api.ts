import { api, APIError, ErrCode } from 'encore.dev/api'
import { randomUUID } from 'node:crypto'
import { type ServerResponse } from 'node:http'
import { RollbackManager, type RollbackManifest } from '../agent/rollback/rollbackManager'
import { parseJsonBody, parsePathPart, writeJson } from '../common/http'
import {
  addArtifact,
  cancelJobByRunId,
  cancelRun,
  createQueuedRun,
  getRun,
  insertEventWithNextSeq,
  listArtifacts,
  listEvents,
  listEventsAfter,
  listRuns,
  resolveMaxJobAttempts,
} from '../data/db'
import { getJsonObject, readRollbackManifestFromDisk, rollbackManifestKey, rollbackRootPath, syncRollbackManifest } from '../storage/storage'
import { enqueueRun } from '../worker/queue'

import '../auth/auth'

interface CreateRunRequest {
  prompt?: string
  input?: unknown
  stream?: boolean
  provider?: string
  model?: string
  workspaceBackend?: 'host' | 'e2b'
}

interface RunPathRequest {
  id: string
}

interface RollbackRequest extends RunPathRequest {
  confirm?: string
}

interface RunSummaryResponse {
  id: string
  status: string
  createdAt: string
  updatedAt: string
  prompt: string
  input: unknown | null
  provider: string | null
  model: string | null
  output: string | null
  error: string | null
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  durationMs: number | null
}

interface CancelRunResponse {
  id: string
  status: 'cancelled'
}

interface RollbackGetResponse {
  ok: true
  manifest: RollbackManifest
}

interface RollbackPostResponse {
  ok: true
  restored: string[]
}

interface RegisterArtifactRequest extends RunPathRequest {
  name: string
  path: string
  mime?: string
  size?: number
}

interface RegisterArtifactResponse {
  ok: true
}

function writeSSE(
  res: ServerResponse,
  event: { id: string; event: string; data: string },
) {
  res.write(`id: ${event.id}\n`)
  res.write(`event: ${event.event}\n`)
  res.write(`data: ${event.data}\n\n`)
}

function streamRunTerminal(status: string) {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

async function streamRunEvents(runId: string, res: ServerResponse) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-run-id', runId)

  let chain = Promise.resolve()
  let lastId = 0

  const writeQueued = (event: { id: number; event: string; data: unknown; ts: string }) => {
    chain = chain
      .then(async () => {
        writeSSE(res, {
          id: String(event.id),
          event: event.event,
          data: JSON.stringify(event),
        })
      })
      .catch(() => undefined)
  }

  const heartbeat = setInterval(() => {
    chain = chain
      .then(async () => {
        writeSSE(res, {
          id: String(lastId),
          event: 'ping',
          data: JSON.stringify({ ts: new Date().toISOString() }),
        })
      })
      .catch(() => undefined)
  }, 15_000)

  try {
    const initialEvents = await listEvents(runId)
    for (const event of initialEvents) {
      writeQueued({
        id: event.id,
        event: event.type,
        data: event.payload,
        ts: event.ts,
      })
      lastId = event.id
    }
  } catch {
    clearInterval(heartbeat)
    res.end()
    return
  }

  const pollInterval = setInterval(async () => {
    try {
      const next = await listEventsAfter(runId, lastId)
      for (const event of next) {
        writeQueued({
          id: event.id,
          event: event.type,
          data: event.payload,
          ts: event.ts,
        })
        lastId = event.id
      }

      const run = await getRun(runId)
      if (!run || streamRunTerminal(run.status)) {
        clearInterval(pollInterval)
        clearInterval(heartbeat)
        await chain
        res.end()
      }
    } catch {
      // Keep stream open; callers can reconnect if needed.
    }
  }, 1000)

  const close = async () => {
    clearInterval(pollInterval)
    clearInterval(heartbeat)
    await chain
  }

  res.on('close', () => {
    void close()
  })
}

export const createRun = api.raw(
  { method: 'POST', path: '/runs', expose: true, auth: true },
  async (req, res) => {
    let payload: CreateRunRequest
    try {
      payload = await parseJsonBody<CreateRunRequest>(req)
    } catch {
      writeJson(res, 400, { error: 'Invalid JSON payload' })
      return
    }

    if (!payload.prompt) {
      writeJson(res, 400, { error: 'prompt is required' })
      return
    }

    const runId = randomUUID()
    await createQueuedRun({
      id: runId,
      prompt: payload.prompt,
      input: payload.input,
      provider: payload.provider,
      model: payload.model,
      workspaceBackend: payload.workspaceBackend,
      maxAttempts: resolveMaxJobAttempts(),
    })

    await enqueueRun(runId)

    if (payload.stream !== false) {
      await streamRunEvents(runId, res)
      return
    }

    writeJson(res, 200, { id: runId, status: 'queued' })
  },
)

export const runs = api.raw(
  { method: 'GET', path: '/runs', expose: true, auth: true },
  async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const records = await listRuns(limit, offset)
    writeJson(res, 200, records)
  },
)

export const runById = api(
  { method: 'GET', path: '/runs/:id', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<RunSummaryResponse> => {
    const run = await getRun(id)
    if (!run) throw APIError.notFound('run not found')

    return {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      prompt: run.prompt,
      input: run.input,
      provider: run.provider,
      model: run.model,
      output: run.output,
      error: run.error,
      usage: run.inputTokens != null
        ? { inputTokens: run.inputTokens, outputTokens: run.outputTokens ?? 0, totalTokens: run.totalTokens ?? 0 }
        : null,
      durationMs: run.durationMs,
    }
  },
)

export const runStream = api.raw(
  { method: 'GET', path: '/runs/:id/stream', expose: true, auth: true },
  async (req, res) => {
    const id = parsePathPart(req, 1)
    const run = await getRun(id)
    if (!run) {
      writeJson(res, 404, { error: 'run not found' })
      return
    }

    await streamRunEvents(run.id, res)
  },
)

export const runEvents = api.raw(
  { method: 'GET', path: '/runs/:id/events', expose: true, auth: true },
  async (req, res) => {
    const id = parsePathPart(req, 1)
    const events = await listEvents(id)
    writeJson(res, 200, events)
  },
)

export const runArtifacts = api.raw(
  { method: 'GET', path: '/runs/:id/artifacts', expose: true, auth: true },
  async (req, res) => {
    const id = parsePathPart(req, 1)
    const artifacts = await listArtifacts(id)
    writeJson(res, 200, artifacts)
  },
)

export const cancelRunEndpoint = api(
  { method: 'POST', path: '/runs/:id/cancel', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<CancelRunResponse> => {
    const run = await getRun(id)
    if (!run) throw APIError.notFound('run not found')

    if (run.status === 'completed' || run.status === 'error') {
      throw APIError.alreadyExists(`cannot cancel run in terminal status '${run.status}'`)
    }

    if (run.status === 'cancelled') {
      return { id, status: 'cancelled' }
    }

    await cancelRun(id)
    await cancelJobByRunId(id)
    await insertEventWithNextSeq({
      runId: id,
      type: 'status',
      payload: { status: 'cancelled' },
    })

    return { id, status: 'cancelled' }
  },
)

export const rollbackGet = api(
  { method: 'GET', path: '/runs/:id/rollback', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<RollbackGetResponse> => {
    if (process.env.ALLOW_ROLLBACK === 'false') {
      throw APIError.permissionDenied('rollback_disabled')
    }

    const run = await getRun(id)
    if (!run) throw APIError.notFound('not found')

    const fromBucket = await getJsonObject<unknown>(rollbackManifestKey(id))
    if (fromBucket) {
      try {
        const manifest = RollbackManager.parseManifest(JSON.stringify(fromBucket), id)
        return { ok: true, manifest }
      } catch {
        // Fall back to disk manifest if object storage contains stale/corrupt data.
      }
    }

    try {
      const manifest = await readRollbackManifestFromDisk(id)
      await syncRollbackManifest(id).catch(() => undefined)
      return { ok: true, manifest }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as any).code) : ''
      if (code === 'ENOENT') throw APIError.notFound('not found')
      throw new APIError(ErrCode.Internal, error instanceof Error ? error.message : String(error))
    }
  },
)

export const rollbackPost = api(
  { method: 'POST', path: '/runs/:id/rollback', expose: true, auth: true },
  async ({ id, confirm }: RollbackRequest): Promise<RollbackPostResponse> => {
    if (process.env.ALLOW_ROLLBACK === 'false') {
      throw APIError.permissionDenied('rollback_disabled')
    }

    const run = await getRun(id)
    if (!run) throw APIError.notFound('not found')

    if (confirm !== 'rollback') {
      throw APIError.invalidArgument("Missing confirm='rollback'")
    }

    const result = RollbackManager.restoreFromDisk({
      runId: id,
      rollbackRoot: rollbackRootPath(),
    })

    await insertEventWithNextSeq({
      runId: id,
      type: 'status',
      payload: { status: 'rolled_back', files: result.restored },
    }).catch(() => undefined)

    await syncRollbackManifest(id).catch(() => undefined)

    return { ok: true, ...result }
  },
)

export const registerArtifact = api(
  { method: 'POST', path: '/runs/:id/artifacts/register', expose: true, auth: true },
  async ({ id, name, path: artifactPath, mime, size }: RegisterArtifactRequest): Promise<RegisterArtifactResponse> => {
    await addArtifact({
      runId: id,
      name,
      path: artifactPath,
      mime,
      size,
    })

    return { ok: true }
  },
)
