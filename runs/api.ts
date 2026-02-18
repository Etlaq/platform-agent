import { api, APIError, type Query } from 'encore.dev/api'
import { secret } from 'encore.dev/config'
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
  createProject,
  createProjectRun,
  getLatestWritableRun,
  getProject,
  getRunInProject,
  insertEventWithNextSeq,
  listArtifacts,
  listEventsAfter,
  listProjectRunMessages,
  listProjectRuns,
  listProjects,
  type ProjectRecord,
  type RunRecord,
} from '../data/db'
import { getBinaryObject } from '../storage/storage'
import { enqueueRun } from '../worker/queue'

import '../auth/auth'

interface CreateProjectRequest {
  id?: string
  name?: string
}

interface CreateProjectResponse {
  id: string
  name: string
  latestRunId: string | null
  createdAt: string
  updatedAt: string
  created: boolean
}

interface ProjectPathRequest {
  projectId: string
}

interface ListProjectsRequest {
  limit?: Query<number>
  offset?: Query<number>
}

interface ListProjectRunsRequest {
  projectId: string
  limit?: Query<number>
  offset?: Query<number>
}

interface ProjectRunPathRequest {
  projectId: string
  id: string
}

interface CreateProjectRunRequest {
  prompt?: string
  input?: unknown
  stream?: boolean
  provider?: string
  model?: string
  workspaceBackend?: string
}

interface CreateProjectRunResponse {
  id: string
  projectId: string
  status: string
  runIndex: number
  writable: boolean
  parentRunId: string | null
  created: boolean
}

interface CreateProjectMessageRequest {
  content?: string
  input?: unknown
  stream?: boolean
  provider?: string
  model?: string
  workspaceBackend?: string
}

interface CreateProjectMessageResponse {
  run: CreateProjectRunResponse
  message: {
    role: string
    content: string
    createdAt: string
  }
}

interface ProjectRunMessageResponse {
  id: number
  projectId: string
  runId: string
  role: string
  content: string
  input: unknown | null
  createdAt: string
}

interface RunSummaryResponse {
  id: string
  projectId: string
  runIndex: number
  writable: boolean
  parentRunId: string | null
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
  projectId: string
  status: string
  cancelled: boolean
  writable: boolean
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

const e2bApiKeySecrets = [secret('E2B_API_KEY'), secret('E2BApiKey')]
const e2bTemplateSecrets = [secret('E2B_TEMPLATE'), secret('E2BTemplate')]

function normalizeSecret(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function setFromSecretsIfMissing(envKey: string, readSecrets: Array<() => string>) {
  const current = normalizeSecret(process.env[envKey])
  if (current) return

  for (const readSecret of readSecrets) {
    try {
      const secretValue = normalizeSecret(readSecret())
      if (secretValue) {
        process.env[envKey] = secretValue
        return
      }
    } catch {
      // Runtime validation will surface errors when required values are absent.
    }
  }
}

function hydrateRunsEnvFromSecrets() {
  setFromSecretsIfMissing('E2B_API_KEY', e2bApiKeySecrets)
  setFromSecretsIfMissing('E2B_TEMPLATE', e2bTemplateSecrets)
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

function parseProjectId(req: IncomingMessage) {
  return parsePathPartAfter(req, 'projects')
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
  hydrateRunsEnvFromSecrets()

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

async function streamRunEvents(req: IncomingMessage, projectId: string, runId: string, res: ServerResponse) {
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

      const run = await getRunInProject(projectId, runId)
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

function toSummary(run: RunRecord): RunSummaryResponse {
  return {
    id: run.id,
    projectId: run.projectId,
    runIndex: run.runIndex,
    writable: run.writable,
    parentRunId: run.parentRunId,
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

function toProjectResponse(project: ProjectRecord, created: boolean): CreateProjectResponse {
  return {
    id: project.id,
    name: project.name,
    latestRunId: project.latestRunId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    created,
  }
}

function toCreateRunResponse(run: RunRecord, created: boolean): CreateProjectRunResponse {
  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    runIndex: run.runIndex,
    writable: run.writable,
    parentRunId: run.parentRunId,
    created,
  }
}

function buildPromptFromMessage(params: {
  content: string
  previous: RunRecord | null
}) {
  if (!params.previous) {
    return params.content
  }

  const sections: string[] = [
    'Continue work for this project based on the latest state and user request.',
    `Previous run id: ${params.previous.id}`,
    `Previous run prompt:\n${params.previous.prompt}`,
  ]

  if (params.previous.output?.trim()) {
    sections.push(`Previous run output:\n${params.previous.output}`)
  }

  sections.push(`User message:\n${params.content}`)
  return sections.join('\n\n')
}

async function ensureProjectExists(projectId: string) {
  const project = await getProject(projectId)
  if (!project) throw APIError.notFound('project not found')
  return project
}

async function handleCreateProjectRequest(req: IncomingMessage, res: ServerResponse) {
  let payload: CreateProjectRequest
  try {
    payload = await parseJsonBody<CreateProjectRequest>(req)
  } catch {
    writeRouteError(res, 400, 'Invalid JSON payload', 'invalid_json')
    return
  }

  const normalizedId = payload.id?.trim() || randomUUID()
  if (!normalizedId) {
    writeRouteError(res, 400, 'project id is required', 'invalid_argument')
    return
  }

  const upsert = await createProject({
    id: normalizedId,
    name: payload.name,
  })

  writeApiSuccess(res, 200, toProjectResponse(upsert.project, upsert.created))
}

async function handleCreateProjectRunRequest(req: IncomingMessage, res: ServerResponse) {
  const projectId = parseProjectId(req)
  if (!projectId) {
    writeRouteError(res, 400, 'project id is required', 'invalid_argument')
    return
  }

  let payload: CreateProjectRunRequest
  try {
    payload = await parseJsonBody<CreateProjectRunRequest>(req)
  } catch {
    writeRouteError(res, 400, 'Invalid JSON payload', 'invalid_json')
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

  await ensureProjectExists(projectId)

  const upsert = await createProjectRun({
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
    await streamRunEvents(req, projectId, upsert.run.id, res)
    return
  }

  writeApiSuccess(res, 200, toCreateRunResponse(upsert.run, upsert.created))
}

async function handleCreateProjectMessageRequest(req: IncomingMessage, res: ServerResponse) {
  const projectId = parseProjectId(req)
  if (!projectId) {
    writeRouteError(res, 400, 'project id is required', 'invalid_argument')
    return
  }

  let payload: CreateProjectMessageRequest
  try {
    payload = await parseJsonBody<CreateProjectMessageRequest>(req)
  } catch {
    writeRouteError(res, 400, 'Invalid JSON payload', 'invalid_json')
    return
  }

  const content = payload.content?.trim()
  if (!content) {
    writeRouteError(res, 400, 'content is required', 'invalid_argument')
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

  await ensureProjectExists(projectId)

  const previous = await getLatestWritableRun(projectId)
  const prompt = buildPromptFromMessage({
    content,
    previous,
  })

  const upsert = await createProjectRun({
    id: randomUUID(),
    projectId,
    idempotencyKey,
    prompt,
    input: payload.input,
    provider: payload.provider,
    model: payload.model,
    workspaceBackend,
    maxAttempts: undefined,
    parentRunId: previous?.id ?? null,
    message: {
      role: 'user',
      content,
      input: payload.input,
    },
  })

  if (upsert.created || upsert.run.status === 'queued') {
    await enqueueRun(upsert.run.id)
  }

  if (payload.stream === true) {
    await streamRunEvents(req, projectId, upsert.run.id, res)
    return
  }

  const runMessages = await listProjectRunMessages(projectId, upsert.run.id, 200).catch(() => [])
  const lastUserMessage = [...runMessages]
    .reverse()
    .find((message) => message.role === 'user' && message.content === content)
  const messageCreatedAt = lastUserMessage?.createdAt ?? new Date().toISOString()

  const body: CreateProjectMessageResponse = {
    run: toCreateRunResponse(upsert.run, upsert.created),
    message: {
      role: 'user',
      content,
      createdAt: messageCreatedAt,
    },
  }

  writeApiSuccess(res, 200, body)
}

async function handleRunStreamRequest(req: IncomingMessage, res: ServerResponse) {
  const projectId = parseProjectId(req)
  const runId = parseRunId(req)

  if (!projectId) {
    writeRouteError(res, 400, 'project id is required', 'invalid_argument')
    return
  }

  if (!runId) {
    writeRouteError(res, 400, 'run id is required', 'invalid_argument')
    return
  }

  const run = await getRunInProject(projectId, runId)
  if (!run) {
    writeRouteError(res, 404, 'run not found', 'not_found')
    return
  }

  await streamRunEvents(req, projectId, run.id, res)
}

async function getRunSummary(projectId: string, id: string): Promise<RunSummaryResponse> {
  const run = await getRunInProject(projectId, id)
  if (!run) throw APIError.notFound('run not found')
  return toSummary(run)
}

async function cancelRunById(projectId: string, id: string): Promise<CancelRunResponse> {
  const run = await getRunInProject(projectId, id)
  if (!run) throw APIError.notFound('run not found')

  if (!run.writable) {
    return {
      id,
      projectId,
      status: run.status,
      cancelled: false,
      writable: false,
    }
  }

  if (run.status === 'cancelled') {
    return { id, projectId, status: 'cancelled', cancelled: false, writable: true }
  }

  if (run.status === 'completed' || run.status === 'error') {
    return { id, projectId, status: run.status, cancelled: false, writable: true }
  }

  await cancelRun(id)
  await cancelJobByRunId(id)
  await insertEventWithNextSeq({
    runId: id,
    type: 'status',
    payload: { status: 'cancelled' },
  })

  return { id, projectId, status: 'cancelled', cancelled: true, writable: true }
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
  hydrateRunsEnvFromSecrets()

  const projectId = parseProjectId(req)
  const id = parseRunId(req)

  if (!projectId) {
    writeRouteError(res, 400, 'project id is required', 'invalid_argument')
    return
  }

  if (!id) {
    writeRouteError(res, 400, 'run id is required', 'invalid_argument')
    return
  }

  const run = await getRunInProject(projectId, id)
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

interface ProjectSummaryResponse {
  id: string
  name: string
  latestRunId: string | null
  createdAt: string
  updatedAt: string
}

function toProjectSummary(project: ProjectRecord): ProjectSummaryResponse {
  return {
    id: project.id,
    name: project.name,
    latestRunId: project.latestRunId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export const createProjectV1 = api.raw(
  { method: 'POST', path: '/v1/projects', expose: true, auth: true },
  async (req, res) => handleCreateProjectRequest(req, res),
)

export const listProjectsV1 = api(
  { method: 'GET', path: '/v1/projects', expose: true, auth: true },
  async ({ limit, offset }: ListProjectsRequest): Promise<ApiSuccess<ProjectSummaryResponse[]>> => {
    const projects = await listProjects(Number(limit ?? 50), Number(offset ?? 0))
    return apiSuccess(projects.map(toProjectSummary))
  },
)

export const projectByIdV1 = api(
  { method: 'GET', path: '/v1/projects/:projectId', expose: true, auth: true },
  async ({ projectId }: ProjectPathRequest): Promise<ApiSuccess<ProjectSummaryResponse>> => {
    const project = await getProject(projectId)
    if (!project) throw APIError.notFound('project not found')
    return apiSuccess(toProjectSummary(project))
  },
)

export const createProjectRunV1 = api.raw(
  { method: 'POST', path: '/v1/projects/:projectId/runs', expose: true, auth: true },
  async (req, res) => handleCreateProjectRunRequest(req, res),
)

export const createProjectMessageV1 = api.raw(
  { method: 'POST', path: '/v1/projects/:projectId/messages', expose: true, auth: true },
  async (req, res) => handleCreateProjectMessageRequest(req, res),
)

export const projectRunsV1 = api(
  { method: 'GET', path: '/v1/projects/:projectId/runs', expose: true, auth: true },
  async ({ projectId, limit, offset }: ListProjectRunsRequest): Promise<ApiSuccess<RunSummaryResponse[]>> => {
    await ensureProjectExists(projectId)
    const runs = await listProjectRuns(projectId, Number(limit ?? 50), Number(offset ?? 0))
    return apiSuccess(runs.map(toSummary))
  },
)

export const projectRunByIdV1 = api(
  { method: 'GET', path: '/v1/projects/:projectId/runs/:id', expose: true, auth: true },
  async ({ projectId, id }: ProjectRunPathRequest): Promise<ApiSuccess<RunSummaryResponse>> => apiSuccess(await getRunSummary(projectId, id)),
)

export const projectRunMessagesV1 = api(
  { method: 'GET', path: '/v1/projects/:projectId/runs/:id/messages', expose: true, auth: true },
  async ({ projectId, id }: ProjectRunPathRequest): Promise<ApiSuccess<ProjectRunMessageResponse[]>> => {
    const run = await getRunInProject(projectId, id)
    if (!run) throw APIError.notFound('run not found')
    return apiSuccess(await listProjectRunMessages(projectId, id, 200))
  },
)

export const projectRunStreamV1 = api.raw(
  { method: 'GET', path: '/v1/projects/:projectId/runs/:id/stream', expose: true, auth: true },
  async (req, res) => handleRunStreamRequest(req, res),
)

export const cancelProjectRunEndpointV1 = api(
  { method: 'POST', path: '/v1/projects/:projectId/runs/:id/cancel', expose: true, auth: true },
  async ({ projectId, id }: ProjectRunPathRequest): Promise<ApiSuccess<CancelRunResponse>> => apiSuccess(await cancelRunById(projectId, id)),
)

export const projectRunDownloadZipV1 = api.raw(
  { method: 'GET', path: '/v1/projects/:projectId/runs/:id/download.zip', expose: true, auth: true },
  async (req, res) => handleRunDownloadZip(req, res),
)
