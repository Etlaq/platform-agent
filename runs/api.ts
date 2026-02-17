import { api, APIError, ErrCode } from 'encore.dev/api'
import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { RollbackManager, type RollbackManifest } from '../agent/rollback/rollbackManager'
import { apiSuccess, type ApiSuccess } from '../common/apiContract'
import { parseJsonBody, parsePathPartAfter, writeApiError, writeApiSuccess, writeJson } from '../common/http'
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

interface CreateRunResponse {
  id: string
  status: 'queued'
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
  modelSource: string | null
  output: string | null
  error: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedInputTokens: number
    reasoningOutputTokens: number
  } | null
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

function parseRunId(req: IncomingMessage) {
  return parsePathPartAfter(req, 'runs')
}

function writeRouteError(
  res: ServerResponse,
  status: number,
  message: string,
  opts?: { v1?: boolean; code?: string },
) {
  if (opts?.v1) {
    writeApiError(res, status, opts.code ?? 'invalid_request', message)
    return
  }
  writeJson(res, status, { error: message })
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

async function handleCreateRunRequest(req: IncomingMessage, res: ServerResponse, v1: boolean) {
  let payload: CreateRunRequest
  try {
    payload = await parseJsonBody<CreateRunRequest>(req)
  } catch {
    writeRouteError(res, 400, 'Invalid JSON payload', { v1, code: 'invalid_json' })
    return
  }

  if (!payload.prompt) {
    writeRouteError(res, 400, 'prompt is required', { v1, code: 'invalid_argument' })
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

  const body: CreateRunResponse = { id: runId, status: 'queued' }
  if (v1) {
    writeApiSuccess(res, 200, body)
    return
  }
  writeJson(res, 200, body)
}

async function handleListRunsRequest(req: IncomingMessage, res: ServerResponse, v1: boolean) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const limit = Number(url.searchParams.get('limit') ?? 50)
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const records = await listRuns(limit, offset)
  if (v1) {
    writeApiSuccess(res, 200, records)
    return
  }
  writeJson(res, 200, records)
}

async function handleRunStreamRequest(req: IncomingMessage, res: ServerResponse, v1: boolean) {
  const id = parseRunId(req)
  if (!id) {
    writeRouteError(res, 400, 'run id is required', { v1, code: 'invalid_argument' })
    return
  }

  const run = await getRun(id)
  if (!run) {
    writeRouteError(res, 404, 'run not found', { v1, code: 'not_found' })
    return
  }

  await streamRunEvents(run.id, res)
}

async function handleRunEventsRequest(req: IncomingMessage, res: ServerResponse, v1: boolean) {
  const id = parseRunId(req)
  if (!id) {
    writeRouteError(res, 400, 'run id is required', { v1, code: 'invalid_argument' })
    return
  }

  const events = await listEvents(id)
  if (v1) {
    writeApiSuccess(res, 200, events)
    return
  }
  writeJson(res, 200, events)
}

async function handleRunArtifactsRequest(req: IncomingMessage, res: ServerResponse, v1: boolean) {
  const id = parseRunId(req)
  if (!id) {
    writeRouteError(res, 400, 'run id is required', { v1, code: 'invalid_argument' })
    return
  }

  const artifacts = await listArtifacts(id)
  if (v1) {
    writeApiSuccess(res, 200, artifacts)
    return
  }
  writeJson(res, 200, artifacts)
}

async function getRunSummary(id: string): Promise<RunSummaryResponse> {
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
    modelSource: run.modelSource,
    output: run.output,
    error: run.error,
    usage: run.inputTokens != null
      ? {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens ?? 0,
          totalTokens: run.totalTokens ?? 0,
          cachedInputTokens: run.cachedInputTokens ?? 0,
          reasoningOutputTokens: run.reasoningOutputTokens ?? 0,
        }
      : null,
    durationMs: run.durationMs,
  }
}

async function cancelRunById(id: string): Promise<CancelRunResponse> {
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
}

async function getRollbackManifest(id: string): Promise<RollbackGetResponse> {
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
}

async function restoreRollback(req: RollbackRequest): Promise<RollbackPostResponse> {
  if (process.env.ALLOW_ROLLBACK === 'false') {
    throw APIError.permissionDenied('rollback_disabled')
  }

  const run = await getRun(req.id)
  if (!run) throw APIError.notFound('not found')

  if (req.confirm !== 'rollback') {
    throw APIError.invalidArgument("Missing confirm='rollback'")
  }

  const result = RollbackManager.restoreFromDisk({
    runId: req.id,
    rollbackRoot: rollbackRootPath(),
  })

  await insertEventWithNextSeq({
    runId: req.id,
    type: 'status',
    payload: { status: 'rolled_back', files: result.restored },
  }).catch(() => undefined)

  await syncRollbackManifest(req.id).catch(() => undefined)

  return { ok: true, ...result }
}

async function registerRunArtifact(req: RegisterArtifactRequest): Promise<RegisterArtifactResponse> {
  await addArtifact({
    runId: req.id,
    name: req.name,
    path: req.path,
    mime: req.mime,
    size: req.size,
  })

  return { ok: true }
}

export const createRun = api.raw(
  { method: 'POST', path: '/runs', expose: true, auth: true },
  async (req, res) => handleCreateRunRequest(req, res, false),
)

export const createRunV1 = api.raw(
  { method: 'POST', path: '/v1/runs', expose: true, auth: true },
  async (req, res) => handleCreateRunRequest(req, res, true),
)

export const runs = api.raw(
  { method: 'GET', path: '/runs', expose: true, auth: true },
  async (req, res) => handleListRunsRequest(req, res, false),
)

export const runsV1 = api.raw(
  { method: 'GET', path: '/v1/runs', expose: true, auth: true },
  async (req, res) => handleListRunsRequest(req, res, true),
)

export const runById = api(
  { method: 'GET', path: '/runs/:id', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<RunSummaryResponse> => getRunSummary(id),
)

export const runByIdV1 = api(
  { method: 'GET', path: '/v1/runs/:id', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<ApiSuccess<RunSummaryResponse>> => apiSuccess(await getRunSummary(id)),
)

export const runStream = api.raw(
  { method: 'GET', path: '/runs/:id/stream', expose: true, auth: true },
  async (req, res) => handleRunStreamRequest(req, res, false),
)

export const runStreamV1 = api.raw(
  { method: 'GET', path: '/v1/runs/:id/stream', expose: true, auth: true },
  async (req, res) => handleRunStreamRequest(req, res, true),
)

export const runEvents = api.raw(
  { method: 'GET', path: '/runs/:id/events', expose: true, auth: true },
  async (req, res) => handleRunEventsRequest(req, res, false),
)

export const runEventsV1 = api.raw(
  { method: 'GET', path: '/v1/runs/:id/events', expose: true, auth: true },
  async (req, res) => handleRunEventsRequest(req, res, true),
)

export const runArtifacts = api.raw(
  { method: 'GET', path: '/runs/:id/artifacts', expose: true, auth: true },
  async (req, res) => handleRunArtifactsRequest(req, res, false),
)

export const runArtifactsV1 = api.raw(
  { method: 'GET', path: '/v1/runs/:id/artifacts', expose: true, auth: true },
  async (req, res) => handleRunArtifactsRequest(req, res, true),
)

export const cancelRunEndpoint = api(
  { method: 'POST', path: '/runs/:id/cancel', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<CancelRunResponse> => cancelRunById(id),
)

export const cancelRunEndpointV1 = api(
  { method: 'POST', path: '/v1/runs/:id/cancel', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<ApiSuccess<CancelRunResponse>> => apiSuccess(await cancelRunById(id)),
)

export const rollbackGet = api(
  { method: 'GET', path: '/runs/:id/rollback', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<RollbackGetResponse> => getRollbackManifest(id),
)

export const rollbackGetV1 = api(
  { method: 'GET', path: '/v1/runs/:id/rollback', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<ApiSuccess<RollbackGetResponse>> => apiSuccess(await getRollbackManifest(id)),
)

export const rollbackPost = api(
  { method: 'POST', path: '/runs/:id/rollback', expose: true, auth: true },
  async (req: RollbackRequest): Promise<RollbackPostResponse> => restoreRollback(req),
)

export const rollbackPostV1 = api(
  { method: 'POST', path: '/v1/runs/:id/rollback', expose: true, auth: true },
  async (req: RollbackRequest): Promise<ApiSuccess<RollbackPostResponse>> => apiSuccess(await restoreRollback(req)),
)

export const registerArtifact = api(
  { method: 'POST', path: '/runs/:id/artifacts/register', expose: true, auth: true },
  async (req: RegisterArtifactRequest): Promise<RegisterArtifactResponse> => registerRunArtifact(req),
)

export const registerArtifactV1 = api(
  { method: 'POST', path: '/v1/runs/:id/artifacts/register', expose: true, auth: true },
  async (req: RegisterArtifactRequest): Promise<ApiSuccess<RegisterArtifactResponse>> => apiSuccess(await registerRunArtifact(req)),
)
