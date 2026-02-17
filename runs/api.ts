import { api, APIError } from 'encore.dev/api'
import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import { apiSuccess, type ApiSuccess } from '../common/apiContract'
import { createStoredZipStream } from '../common/zip'
import { parseJsonBody, parsePathPartAfter, writeApiError, writeApiSuccess } from '../common/http'
import { parseByteLimit, resolveWorkspaceRoot, toPosixRelPath } from '../common/workspace'
import { isDeniedEnvFile, isDeniedSensitiveFile } from '../common/fileSensitivity'
import { resolveSandboxAppDir } from '../common/e2b'
import { connectSandboxWithRetry } from '../common/e2bSandbox'
import { buildSandboxZipBuffer } from '../common/sandboxZip'
import {
  cancelJobByRunId,
  cancelRun,
  createQueuedRun,
  getRun,
  insertEventWithNextSeq,
  listArtifacts,
  listEventsAfter,
} from '../data/db'
import { getBinaryObject } from '../storage/storage'
import { enqueueRun } from '../worker/queue'

import '../auth/auth'

interface CreateRunRequest {
  projectId?: string
  prompt?: string
  input?: unknown
  stream?: boolean
  provider?: string
  model?: string
  workspaceBackend?: string
}

interface CreateRunResponse {
  id: string
  status: string
  created: boolean
}

interface RunPathRequest {
  id: string
}

interface RunSummaryResponse {
  id: string
  projectId: string
  status: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
  prompt: string
  input: unknown | null
  output: string | null
  error: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cachedInputTokens: number
    reasoningOutputTokens: number
  } | null
  cost: {
    currency: string
    estimatedUsd: number | null
    pricingVersion: string | null
  } | null
  meta: {
    provider: string | null
    model: string | null
    modelSource: string | null
    usageSource: 'response_usage' | null
    pricingSource: 'model_pricing_table' | null
    attempt: number
    maxAttempts: number
    sandboxId: string | null
    idempotencyKey: string | null
  }
}

interface CancelRunResponse {
  id: string
  status: string
  cancelled: boolean
}

type WorkspaceZipEntry = {
  absPath: string
  relPath: string
  size: number
  mtimeMs: number
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.aws',
  '.ssh',
  '.gnupg',
  '.kube',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.agents',
  '.turbo',
  '.cache',
  'tmp',
])

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

function parseRequiredIdempotencyKey(req: IncomingMessage) {
  const raw = req.headers['idempotency-key']
  const token = Array.isArray(raw) ? raw[0] : raw
  const normalized = typeof token === 'string' ? token.trim() : ''
  if (!normalized) return null
  if (normalized.length > 200) return null
  return normalized
}

function parseWorkspaceBackend(raw: unknown): 'host' | 'e2b' | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'host' || normalized === 'e2b') return normalized
  return null
}

function resolveDefaultWorkspaceBackend(): 'host' | 'e2b' {
  const envChoice =
    parseWorkspaceBackend(process.env.AGENT_WORKSPACE_BACKEND) ??
    parseWorkspaceBackend(process.env.WORKSPACE_BACKEND)
  if (envChoice) return envChoice

  if (process.env.E2B_API_KEY && process.env.E2B_TEMPLATE) {
    return 'e2b'
  }

  return 'host'
}

function parseLastEventId(req: IncomingMessage) {
  const raw = req.headers['last-event-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = value ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

async function collectWorkspaceFiles(rootDir: string, opts: { maxBytes: number; maxFiles: number }) {
  const files: WorkspaceZipEntry[] = []
  let total = 0

  const walk = async (absDir: string, relDir: string) => {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true })
    for (const ent of entries) {
      const name = ent.name
      if (name === '.' || name === '..') continue

      if (DEFAULT_EXCLUDE_DIRS.has(name) && ent.isDirectory()) {
        continue
      }

      if (isDeniedEnvFile(name) || isDeniedSensitiveFile(name)) {
        continue
      }

      const absPath = `${absDir}/${name}`
      const relPath = relDir ? `${relDir}/${name}` : name

      let st: fs.Stats
      try {
        st = await fs.promises.lstat(absPath)
      } catch {
        continue
      }

      if (st.isSymbolicLink()) continue

      if (st.isDirectory()) {
        await walk(absPath, relPath)
        continue
      }

      if (!st.isFile()) continue

      const size = st.size
      if (size > 0xffffffff) {
        throw new Error(`File too large for zip: ${relPath}`)
      }

      total += size
      if (total > opts.maxBytes) {
        throw new Error('Zip exceeds ZIP_MAX_BYTES limit.')
      }

      files.push({
        absPath,
        relPath: toPosixRelPath(relPath),
        size,
        mtimeMs: st.mtimeMs,
      })

      if (files.length > opts.maxFiles) {
        throw new Error('Zip exceeds max file count limit.')
      }
    }
  }

  await walk(rootDir, '')
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files
}

async function* readFsFileChunks(absPath: string) {
  const rs = fs.createReadStream(absPath)
  try {
    for await (const chunk of rs as AsyncIterable<Uint8Array | ArrayBufferView | ArrayBuffer>) {
      yield chunk
    }
  } finally {
    rs.close?.()
  }
}

function writeRouteError(
  res: ServerResponse,
  status: number,
  message: string,
  code = 'invalid_request',
) {
  writeApiError(res, status, code, message)
}

async function streamRunEvents(req: IncomingMessage, runId: string, res: ServerResponse) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-run-id', runId)

  let chain = Promise.resolve()
  let lastId = parseLastEventId(req)

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
    const initialEvents = await listEventsAfter(runId, lastId)
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
      // Keep stream open; callers can reconnect and replay from Last-Event-ID.
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

function toSummary(run: NonNullable<Awaited<ReturnType<typeof getRun>>>): RunSummaryResponse {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
    prompt: run.prompt,
    input: run.input,
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
    cost: run.estimatedCostUsd != null || run.pricingVersion
      ? {
          currency: run.costCurrency ?? 'USD',
          estimatedUsd: run.estimatedCostUsd,
          pricingVersion: run.pricingVersion,
        }
      : null,
    meta: {
      provider: run.provider,
      model: run.model,
      modelSource: run.modelSource,
      usageSource: run.inputTokens != null ? 'response_usage' : null,
      pricingSource: run.pricingVersion ? 'model_pricing_table' : null,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      sandboxId: run.sandboxId,
      idempotencyKey: run.idempotencyKey,
    },
  }
}

async function handleCreateRunRequest(req: IncomingMessage, res: ServerResponse) {
  let payload: CreateRunRequest
  try {
    payload = await parseJsonBody<CreateRunRequest>(req)
  } catch {
    writeRouteError(res, 400, 'Invalid JSON payload', 'invalid_json')
    return
  }

  const projectId = payload.projectId?.trim()
  if (!projectId) {
    writeRouteError(res, 400, 'projectId is required', 'invalid_argument')
    return
  }

  if (!payload.prompt?.trim()) {
    writeRouteError(res, 400, 'prompt is required', 'invalid_argument')
    return
  }

  const idempotencyKey = parseRequiredIdempotencyKey(req)
  if (!idempotencyKey) {
    writeRouteError(res, 400, 'Idempotency-Key header is required', 'invalid_argument')
    return
  }

  const workspaceBackend =
    parseWorkspaceBackend(payload.workspaceBackend) ?? resolveDefaultWorkspaceBackend()
  if (payload.workspaceBackend && !parseWorkspaceBackend(payload.workspaceBackend)) {
    writeRouteError(res, 400, 'workspaceBackend must be either host or e2b', 'invalid_argument')
    return
  }

  const upsert = await createQueuedRun({
    id: randomUUID(),
    projectId,
    idempotencyKey,
    prompt: payload.prompt,
    input: payload.input,
    provider: payload.provider,
    model: payload.model,
    workspaceBackend,
    maxAttempts: undefined,
  })

  if (upsert.created || upsert.run.status === 'queued') {
    await enqueueRun(upsert.run.id)
  }

  if (payload.stream === true) {
    await streamRunEvents(req, upsert.run.id, res)
    return
  }

  const body: CreateRunResponse = {
    id: upsert.run.id,
    status: upsert.run.status,
    created: upsert.created,
  }
  writeApiSuccess(res, 200, body)
}

async function handleRunStreamRequest(req: IncomingMessage, res: ServerResponse) {
  const id = parseRunId(req)
  if (!id) {
    writeRouteError(res, 400, 'run id is required', 'invalid_argument')
    return
  }

  const run = await getRun(id)
  if (!run) {
    writeRouteError(res, 404, 'run not found', 'not_found')
    return
  }

  await streamRunEvents(req, run.id, res)
}

async function getRunSummary(id: string): Promise<RunSummaryResponse> {
  const run = await getRun(id)
  if (!run) throw APIError.notFound('run not found')
  return toSummary(run)
}

async function cancelRunById(id: string): Promise<CancelRunResponse> {
  const run = await getRun(id)
  if (!run) throw APIError.notFound('run not found')

  if (run.status === 'cancelled') {
    return { id, status: 'cancelled', cancelled: false }
  }

  if (run.status === 'completed' || run.status === 'error') {
    return { id, status: run.status, cancelled: false }
  }

  await cancelRun(id)
  await cancelJobByRunId(id)
  await insertEventWithNextSeq({
    runId: id,
    type: 'status',
    payload: { status: 'cancelled' },
  })

  return { id, status: 'cancelled', cancelled: true }
}

function writeZipHeaders(res: ServerResponse, filename: string) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', `attachment; filename="${filename}"`)
  res.setHeader('cache-control', 'no-store')
}

async function tryWriteStoredWorkspaceArtifact(runId: string, res: ServerResponse) {
  const artifacts = await listArtifacts(runId)
  const workspaceZip = [...artifacts]
    .reverse()
    .find((artifact) => artifact.name === 'workspace.zip' && artifact.path)
  if (!workspaceZip) return false

  const payload = await getBinaryObject(workspaceZip.path)
  if (!payload) return false

  writeZipHeaders(res, `run-${runId}-workspace.zip`)
  res.end(payload)
  return true
}

async function tryWriteLiveSandboxZip(sandboxId: string, runId: string, res: ServerResponse) {
  try {
    const sandbox = await connectSandboxWithRetry(sandboxId)
    const appDir = resolveSandboxAppDir()
    const { buffer } = await buildSandboxZipBuffer(sandbox, appDir)
    writeZipHeaders(res, `run-${runId}-workspace.zip`)
    res.end(buffer)
    return true
  } catch {
    return false
  }
}

async function writeHostWorkspaceZip(runId: string, res: ServerResponse) {
  const root = resolveWorkspaceRoot()

  let rootStat: fs.Stats
  try {
    rootStat = await fs.promises.stat(root)
  } catch {
    writeRouteError(res, 400, `WORKSPACE_ROOT not found: ${root}`, 'invalid_argument')
    return
  }
  if (!rootStat.isDirectory()) {
    writeRouteError(res, 400, `WORKSPACE_ROOT is not a directory: ${root}`, 'invalid_argument')
    return
  }

  const maxBytes = parseByteLimit(process.env.ZIP_MAX_BYTES, 250 * 1024 * 1024)
  const maxFiles = parseByteLimit(process.env.ZIP_MAX_FILES, 20_000)

  let files: WorkspaceZipEntry[]
  try {
    files = await collectWorkspaceFiles(root, { maxBytes, maxFiles })
  } catch (error) {
    writeRouteError(res, 413, error instanceof Error ? error.message : String(error), 'payload_too_large')
    return
  }

  const stream = createStoredZipStream(files, (file) => readFsFileChunks(file.absPath))
  const reader = stream.getReader()

  writeZipHeaders(res, `run-${runId}-workspace.zip`)

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (error) {
    writeRouteError(res, 500, error instanceof Error ? error.message : String(error), 'internal')
  } finally {
    reader.releaseLock()
  }
}

async function handleRunDownloadZip(req: IncomingMessage, res: ServerResponse) {
  const id = parseRunId(req)
  if (!id) {
    writeRouteError(res, 400, 'run id is required', 'invalid_argument')
    return
  }

  const run = await getRun(id)
  if (!run) {
    writeRouteError(res, 404, 'run not found', 'not_found')
    return
  }

  if (await tryWriteStoredWorkspaceArtifact(id, res)) return
  if (run.sandboxId && await tryWriteLiveSandboxZip(run.sandboxId, id, res)) return

  if (run.workspaceBackend === 'e2b') {
    writeRouteError(
      res,
      409,
      'workspace zip is not available yet for this run. wait for snapshot completion or retry.',
      'unavailable',
    )
    return
  }

  await writeHostWorkspaceZip(id, res)
}

export const createRunV1 = api.raw(
  { method: 'POST', path: '/v1/runs', expose: true, auth: true },
  async (req, res) => handleCreateRunRequest(req, res),
)

export const runByIdV1 = api(
  { method: 'GET', path: '/v1/runs/:id', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<ApiSuccess<RunSummaryResponse>> => apiSuccess(await getRunSummary(id)),
)

export const runStreamV1 = api.raw(
  { method: 'GET', path: '/v1/runs/:id/stream', expose: true, auth: true },
  async (req, res) => handleRunStreamRequest(req, res),
)

export const cancelRunEndpointV1 = api(
  { method: 'POST', path: '/v1/runs/:id/cancel', expose: true, auth: true },
  async ({ id }: RunPathRequest): Promise<ApiSuccess<CancelRunResponse>> => apiSuccess(await cancelRunById(id)),
)

export const runDownloadZipV1 = api.raw(
  { method: 'GET', path: '/v1/runs/:id/download.zip', expose: true, auth: true },
  async (req, res) => handleRunDownloadZip(req, res),
)
