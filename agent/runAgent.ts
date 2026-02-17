import crypto from 'node:crypto'
import {
  CompositeBackend,
  FilesystemBackend,
  createDeepAgent,
  StateBackend,
  type BackendProtocol,
} from 'deepagents'
import type { RunnableConfig } from '@langchain/core/runnables'
import { resolveModelSelection } from './provider'
import { RollbackManager } from './rollback/rollbackManager'
import { GuardedFilesystemBackend } from './backends/guardedFilesystemBackend'
import { GuardedVirtualBackend } from './backends/guardedVirtualBackend'
import { E2BSandboxBackend } from './backends/e2bSandboxBackend'
import { createProjectActionsTool } from './tools/projectActions'
import { createSandboxCmdTool } from './tools/sandboxCmd'
import { Sandbox } from '@e2b/code-interpreter'
import { createSandboxWithRetry, runSandboxCommandWithTimeout } from '../common/e2bSandbox'
import { appendAgentsNote, ensureAgentsMd, loadAgentsMdTemplate } from './agentsMd'
import {
  extractSandboxCmd,
  formatLintFailureForModel,
  isBuildCommand,
  isLintCommand,
  isSuccessfulSandboxResult,
  resolveAutoLintMaxPasses,
  resolveAutoLintTimeoutMs,
  shouldAutoLintAfterBuild,
  toSandboxCmdResult,
} from './autoLint'
import {
  BUILD_PHASE_PROMPT_APPENDIX,
  DEFAULT_MEMORY_DIR,
  DEFAULT_ROLLBACK_DIR,
  DEFAULT_SKILLS_DIR,
  DEFAULT_SUBAGENT_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  E2B_SYSTEM_PROMPT,
  PLAN_PHASE_PROMPT_APPENDIX,
  ensureDir,
  resolveDir,
  resolveWorkspaceRoot,
} from './runtime/config'
import { loadMcpTools } from './runtime/mcp'
import { createModel, normalizeModelName } from './runtime/modelFactory'

export interface AgentRunInput {
  prompt: string
  input?: unknown
  provider?: string
  model?: string
  runId?: string
  workspaceBackend?: 'host' | 'e2b'
  // When false, do not emit per-token events (useful when the caller isn't streaming).
  emitTokens?: boolean
  signal?: AbortSignal
  onEvent?: (event: {
    type: 'token' | 'tool' | 'status'
    payload: unknown
  }) => void
}

export class RunAbortedError extends Error {
  constructor(message = 'Run aborted') {
    super(message)
    this.name = 'RunAbortedError'
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new RunAbortedError()
  }
}

export function isRunAbortedError(err: unknown) {
  if (err instanceof RunAbortedError) return true
  if (!err || typeof err !== 'object') return false
  const maybe = err as { name?: unknown }
  return maybe.name === 'AbortError'
}

function resolvePhaseTimeoutMs(envName: string, fallbackMs: number) {
  const raw = process.env[envName]
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return fallbackMs
  return Math.max(30_000, Math.min(2 * 60 * 60_000, Math.trunc(n)))
}

function buildUserMessage(prompt: string, input?: unknown): string {
  if (input === undefined) return prompt
  return `${prompt}\n\nAdditional input:\n${JSON.stringify(input, null, 2)}`
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '')
        }
        return JSON.stringify(part)
      })
      .join('')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

export interface PlanTodoItem {
  id: string
  title: string
  details?: string
  acceptanceCriteria?: string[]
}

export interface PlanSnapshot {
  summary: string
  todos: PlanTodoItem[]
  raw: string
}

const PLAN_MUTATING_PROJECT_ACTIONS = new Set([
  'secrets_sync_env_example',
  'add_dependencies',
  'run_install',
  'run_next_build',
  'run_typecheck',
  'generate_drizzle_migration',
  'scaffold_authjs_supabase_drizzle',
  'scaffold_cron_supabase_daily',
  'validate_env',
  'rollback_run',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  return out
}

function parseProjectAction(input: unknown): string | null {
  const obj = asRecord(input)
  if (obj) {
    const direct = toNonEmptyString(obj.action)
    if (direct) return direct
  }
  if (typeof input !== 'string') return null
  try {
    const parsed = JSON.parse(input)
    const parsedObj = asRecord(parsed)
    if (!parsedObj) return null
    return toNonEmptyString(parsedObj.action)
  } catch {
    return null
  }
}

function parseSandboxCommandInput(input: unknown): string | null {
  const obj = asRecord(input)
  if (obj) {
    const direct = toNonEmptyString(obj.cmd)
    if (direct) return direct
  }
  if (typeof input !== 'string') return null
  const extracted = extractSandboxCmd(input)
  if (extracted) return extracted
  try {
    const parsed = JSON.parse(input)
    const parsedObj = asRecord(parsed)
    if (!parsedObj) return null
    return toNonEmptyString(parsedObj.cmd)
  } catch {
    return null
  }
}

function detectPlanMutationAttempt(toolName: string, input: unknown): string | null {
  if (toolName === 'project_actions') {
    const action = parseProjectAction(input)
    if (action && PLAN_MUTATING_PROJECT_ACTIONS.has(action)) {
      return `project_actions:${action}`
    }
    return null
  }
  if (toolName === 'sandbox_cmd') {
    const cmd = parseSandboxCommandInput(input)
    if (!cmd) return 'sandbox_cmd'
    return `sandbox_cmd:${cmd.slice(0, 140)}`
  }
  return null
}

function parseJsonCandidates(raw: string) {
  const candidates: string[] = []
  const fenced = /```json\s*([\s\S]*?)```/gi
  for (let match = fenced.exec(raw); match; match = fenced.exec(raw)) {
    candidates.push(match[1] ?? '')
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push(trimmed)
  }
  return candidates
}

function normalizeTodo(value: unknown, index: number): PlanTodoItem | null {
  const obj = asRecord(value)
  if (!obj) return null
  const title =
    toNonEmptyString(obj.title) ??
    toNonEmptyString(obj.task) ??
    toNonEmptyString(obj.todo) ??
    toNonEmptyString(obj.name)
  if (!title) return null
  const id = toNonEmptyString(obj.id) ?? String(index + 1)
  const details = toNonEmptyString(obj.details) ?? toNonEmptyString(obj.description) ?? undefined
  const acceptanceCriteria = toStringArray(obj.acceptanceCriteria)
  return {
    id,
    title,
    ...(details ? { details } : {}),
    ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
  }
}

function parseMarkdownTodos(raw: string): PlanTodoItem[] {
  const lines = raw.split(/\r?\n/)
  const todos: PlanTodoItem[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = /^[-*]\s+(?:\[\s?\]\s+)?(.+)$/.exec(trimmed) ?? /^(\d+)\.\s+(.+)$/.exec(trimmed)
    if (!match) continue

    const title = (match[2] ?? match[1] ?? '').trim()
    if (!title) continue
    todos.push({
      id: String(todos.length + 1),
      title,
    })
  }

  return todos
}

function firstSentence(raw: string) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue
    return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
  }
  return ''
}

function buildFallbackPlan(raw: string, prompt: string): PlanSnapshot {
  const parsedTodos = parseMarkdownTodos(raw)
  if (parsedTodos.length > 0) {
    return {
      summary: firstSentence(raw) || `Execution plan for: ${prompt.slice(0, 120)}`,
      todos: parsedTodos,
      raw,
    }
  }

  return {
    summary: firstSentence(raw) || `Execution plan for: ${prompt.slice(0, 120)}`,
    todos: [
      {
        id: '1',
        title: 'Implement requested change',
        details: 'No structured todos were parsed from phase 1 output; proceed with best effort.',
      },
    ],
    raw,
  }
}

export function parsePlanSnapshot(raw: string): PlanSnapshot | null {
  const candidates = parseJsonCandidates(raw)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const obj = asRecord(parsed)
      if (!obj) continue

      const todosSource = Array.isArray(obj.todos)
        ? obj.todos
        : Array.isArray(obj.tasks)
          ? obj.tasks
          : Array.isArray(obj.steps)
            ? obj.steps
            : []
      const todos = todosSource
        .map((item, index) => normalizeTodo(item, index))
        .filter((item): item is PlanTodoItem => item != null)

      const summary =
        toNonEmptyString(obj.summary) ??
        toNonEmptyString(obj.plan) ??
        toNonEmptyString(obj.overview) ??
        null

      if (!summary && todos.length === 0) continue

      return {
        summary: summary ?? `Plan with ${todos.length} todo${todos.length === 1 ? '' : 's'}.`,
        todos,
        raw,
      }
    } catch {
      continue
    }
  }

  const markdownTodos = parseMarkdownTodos(raw)
  if (markdownTodos.length === 0) return null

  return {
    summary: firstSentence(raw) || `Plan with ${markdownTodos.length} todos.`,
    todos: markdownTodos,
    raw,
  }
}

function buildPlanPhaseMessage(prompt: string, input?: unknown) {
  return `${buildUserMessage(prompt, input)}\n\n${PLAN_PHASE_PROMPT_APPENDIX}`
}

function buildBuildPhaseMessage(plan: PlanSnapshot) {
  return [
    BUILD_PHASE_PROMPT_APPENDIX,
    'Approved plan summary:',
    plan.summary,
    'Approved todos (JSON):',
    JSON.stringify(plan.todos, null, 2),
  ].join('\n\n')
}

function extractAssistantOutput(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown }
    const role = typeof msg?.role === 'string' ? msg.role.toLowerCase() : ''
    if (role === 'assistant' || role === 'ai') {
      return normalizeContent(msg.content)
    }
  }

  const last = messages[messages.length - 1] as { content?: unknown } | undefined
  return normalizeContent(last?.content)
}

export async function runAgent(params: AgentRunInput): Promise<{
  output: string
  messages: unknown[]
  plan?: PlanSnapshot
  model: string
  provider: string
  modelSource: string
  sandboxId?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  cachedInputTokens?: number
  reasoningOutputTokens?: number
  durationMs?: number
}> {
  throwIfAborted(params.signal)
  const selection = resolveModelSelection({
    provider: params.provider,
    model: params.model,
  })

  const resolvedModelName = normalizeModelName(selection.provider, selection.model)
  const model = createModel(selection.provider, resolvedModelName)

  const workspaceMode = params.workspaceBackend ?? 'host'
  const workspaceRoot = resolveWorkspaceRoot()
  const memoryDir = resolveDir('MEMORY_DIR', DEFAULT_MEMORY_DIR)
  const skillsDir = resolveDir('SKILLS_DIR', DEFAULT_SKILLS_DIR)
  const rollbackRoot = resolveDir('ROLLBACK_DIR', DEFAULT_ROLLBACK_DIR)
  ensureDir(memoryDir)
  ensureDir(skillsDir)
  ensureDir(rollbackRoot)

  const runId = params.runId ?? crypto.randomUUID()
  const planPhaseTimeoutMs = resolvePhaseTimeoutMs('AGENT_PLAN_PHASE_TIMEOUT_MS', 5 * 60_000)
  const buildPhaseTimeoutMs = resolvePhaseTimeoutMs('AGENT_BUILD_PHASE_TIMEOUT_MS', 20 * 60_000)
  const rollback =
    workspaceMode === 'host'
      ? new RollbackManager({
          runId,
          rollbackRoot,
          workspaceRoot,
        })
      : null

  const memoryBackend = new FilesystemBackend({
    rootDir: memoryDir,
    virtualMode: true,
  })

  const skillsBackend = new FilesystemBackend({
    rootDir: skillsDir,
    virtualMode: true,
  })

  let sandbox: Sandbox | null = null
  let sandboxId: string | undefined
  let touchedFiles: Set<string> | null = null
  let workspaceFsBackend: BackendProtocol | null = null

  const hostBackend =
    workspaceMode === 'host'
      ? new GuardedFilesystemBackend({
          rootDir: workspaceRoot,
          rollback: rollback!,
        })
      : null

  const e2bBackend = async () => {
    const apiKey = process.env.E2B_API_KEY
    const template = process.env.E2B_TEMPLATE
    const appDir = process.env.SANDBOX_APP_DIR || '/home/user'
    if (!apiKey) throw new Error('E2B_API_KEY is required for workspaceBackend=e2b.')
    if (!template) throw new Error('E2B_TEMPLATE is required for workspaceBackend=e2b.')

    const timeoutRaw = process.env.E2B_SANDBOX_TIMEOUT_MS
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : NaN
    // E2B's SDK default sandbox timeout is too short for long-running installs/builds.
    // If not configured, use a safer default to prevent sandboxes from closing mid-run.
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2 * 60 * 60_000
    sandbox = await createSandboxWithRetry(
      template,
      { timeoutMs: effectiveTimeoutMs },
    )
    sandboxId = (sandbox as any).sandboxId

    // Ensure each sandbox ZIP contains a usable git repo + commit history (used by benchmark harness).
    // Best-effort: never fail the run if git is unavailable in the sandbox.
    try {
      const git = (sandbox as unknown as { git?: unknown }).git
      if (git && typeof (git as { init?: unknown }).init === 'function') {
        const gitApi = git as {
          init: (path: string) => Promise<unknown>
          configureUser?: (name: string, email: string, opts?: { scope?: string; path?: string }) => Promise<unknown>
          add?: (path: string, opts?: { all?: boolean }) => Promise<unknown>
          commit?: (path: string, message: string, opts?: { allowEmpty?: boolean }) => Promise<unknown>
        }
        const authorName = process.env.AGENT_GIT_AUTHOR_NAME || 'Etlaq Agent'
        const authorEmail = process.env.AGENT_GIT_AUTHOR_EMAIL || 'agent@local'

        await gitApi.init(appDir).catch(() => undefined)
        if (typeof gitApi.configureUser === 'function') {
          await gitApi.configureUser(authorName, authorEmail, { scope: 'local', path: appDir }).catch(() => undefined)
        }
        if (typeof gitApi.add === 'function') {
          await gitApi.add(appDir, { all: true }).catch(() => undefined)
        }
        if (typeof gitApi.commit === 'function') {
          await gitApi.commit(appDir, 'chore: initial snapshot', { allowEmpty: true }).catch(() => undefined)
        }
      }
    } catch {
      // ignore
    }

    const fsBackend = new E2BSandboxBackend(sandbox, { rootDir: appDir })
    const guarded = new GuardedVirtualBackend(fsBackend)
    touchedFiles = guarded.touchedFiles

    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'sandbox_created',
        sandboxId,
        appDir,
        nextjsUrl: `https://${sandbox.getHost(3000)}`,
        downloadPath: `/v1/sandbox/${sandboxId}/download.zip`,
        legacyDownloadPath: `/sandbox/${sandboxId}/download.zip`,
      },
    })

    return guarded
  }

  const { tools: mcpTools, client: mcpClient } = await loadMcpTools()

  const allowHostInstalls = process.env.ALLOW_HOST_INSTALLS === 'true'
  const tools: any[] = []
  tools.push(...mcpTools)

  if (workspaceMode === 'e2b') {
    workspaceFsBackend = await e2bBackend()
    const appDir = process.env.SANDBOX_APP_DIR || '/home/user'
    if (sandbox) {
      tools.push(createSandboxCmdTool({ sandbox, defaultCwd: appDir }) as any)
    }
  } else {
    workspaceFsBackend = hostBackend!
  }

  // Always seed project AGENTS.md so it is available as memory for the agent.
  // Preserve the append-only Notes section between runs.
  const seedAgents = process.env.SEED_AGENTS_MD !== 'false'
  if (seedAgents && workspaceFsBackend) {
    await ensureAgentsMd({
      backend: workspaceFsBackend,
      filePath: '/AGENTS.md',
      template: loadAgentsMdTemplate(),
    }).catch(() => {})
  }

  if (workspaceMode === 'host') {
    const actionsTool = createProjectActionsTool({
      workspaceRoot,
      rollback: rollback!,
      allowHostInstalls,
    })
    tools.push(actionsTool)
  }

  const allowList = process.env.ALLOWED_TOOLS
    ? new Set(process.env.ALLOWED_TOOLS.split(',').map((t) => t.trim()).filter(Boolean))
    : new Set(workspaceMode === 'e2b' ? ['sandbox_cmd'] : ['project_actions'])
  const filteredTools = tools.filter((t: any) => allowList.has(t?.name ?? '')) as any[]

  const enableSubagents = process.env.ENABLE_SUBAGENTS !== 'false'
  const subagents = enableSubagents
    ? [
        {
          name: 'research',
          description: 'Investigate and summarize tasks or questions in isolation.',
          systemPrompt: DEFAULT_SUBAGENT_PROMPT,
          tools: filteredTools,
        },
      ]
    : []
  const invokeTags = [
    'etlaq-agent',
    `workspace:${workspaceMode}`,
    `provider:${selection.provider}`,
    `model:${resolvedModelName}`,
  ]
  const invokeMetadata = {
    runId,
    workspaceBackend: workspaceMode,
    provider: selection.provider,
    model: resolvedModelName,
  }

  const backendFactory = (runtime: unknown) => {
    const baseBackend = new StateBackend(runtime as any)
    const wrappedBackend = {
      lsInfo: baseBackend.lsInfo?.bind(baseBackend),
      read: baseBackend.read?.bind(baseBackend),
      readRaw: (baseBackend as any).readRaw?.bind(baseBackend),
      write: baseBackend.write?.bind(baseBackend),
      edit: baseBackend.edit?.bind(baseBackend),
      globInfo: (baseBackend as any).globInfo?.bind(baseBackend),
      grepRaw: (baseBackend as any).grepRaw?.bind(baseBackend),
      uploadFiles: (baseBackend as any).uploadFiles?.bind(baseBackend),
      downloadFiles: (baseBackend as any).downloadFiles?.bind(baseBackend),
    }

    const workspaceBackend = workspaceMode === 'host'
      ? hostBackend!
      : (touchedFiles ? (null as any) : null)

    return new CompositeBackend(wrappedBackend as any, {
      '/memories/': memoryBackend,
      '/skills/': skillsBackend,
      '/': workspaceFsBackend as any,
    })
  }

  const agent = createDeepAgent({
    model,
    tools: filteredTools as any,
    systemPrompt: workspaceMode === 'e2b' ? E2B_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT,
    backend: backendFactory,
    // Inject project-level instructions when present.
    // This uses the AGENTS.md spec supported by DeepAgents' memory middleware.
    memory: ['/AGENTS.md'],
    skills: ['/skills/'],
    subagents: subagents as any,
  } as any)

  let lastAppendedNote = ''
  let currentToolName = ''
  let currentToolInput = ''
  let currentSandboxCmd: string | null = null
  let currentWorkflowPhase: 'plan' | 'build' = 'plan'
  let sawSuccessfulBuildCommand = false
  let sawSuccessfulLintCommand = false
  const safeStringify = (value: unknown) => {
    try {
      return JSON.stringify(value ?? null)
    } catch {
      return String(value)
    }
  }
  const deriveHint = (toolName: string, toolInput: string, out?: any, errMsg?: string) => {
    const input = toolInput.toLowerCase()
    const stderr = typeof out?.stderr === 'string' ? out.stderr.toLowerCase() : ''
    const error = typeof out?.error === 'string' ? out.error.toLowerCase() : ''
    const em = (errMsg ?? '').toLowerCase()

    if (toolName === 'sandbox_cmd' && input.includes('bun run dev')) {
      if (stderr.includes('eaddrinuse') || error.includes('eaddrinuse') || em.includes('eaddrinuse')) {
        return 'E2B Next.js templates often already run the dev server on port 3000; reuse it instead of starting a second dev server.'
      }
      if (stderr.includes('already') && stderr.includes('running')) {
        return 'Dev server may already be running in the sandbox; reuse it.'
      }
    }

    return null
  }
  const callbacks = [
    {
      handleLLMNewToken(token: string) {
        if (params.signal?.aborted) return
        if (params.emitTokens !== false) {
          params.onEvent?.({ type: 'token', payload: { token } })
        }
      },
      handleToolStart(tool: { name?: string }, input: unknown) {
        if (params.signal?.aborted) return
        currentToolName = tool?.name ?? 'tool'
        currentToolInput = typeof input === 'string' ? input : safeStringify(input)
        currentSandboxCmd =
          currentToolName === 'sandbox_cmd' ? extractSandboxCmd(currentToolInput) : null
        params.onEvent?.({
          type: 'tool',
          payload: {
            phase: 'start',
            runPhase: currentWorkflowPhase,
            tool: tool?.name ?? 'tool',
            input,
          },
        })

        if (currentWorkflowPhase === 'plan') {
          const mutation = detectPlanMutationAttempt(currentToolName, input)
          if (mutation) {
            params.onEvent?.({
              type: 'status',
              payload: {
                status: 'plan_policy_warning',
                runId,
                phase: 'plan',
                tool: currentToolName,
                detail: mutation,
              },
            })
          }
        }
      },
      handleToolEnd(output: unknown, runId: string) {
        if (params.signal?.aborted) return
        params.onEvent?.({
          type: 'tool',
          payload: { phase: 'end', runPhase: currentWorkflowPhase, runId, output },
        })

        if (currentWorkflowPhase === 'build' && currentToolName === 'sandbox_cmd' && currentSandboxCmd) {
          if (isBuildCommand(currentSandboxCmd) && isSuccessfulSandboxResult(output)) {
            sawSuccessfulBuildCommand = true
          }
          if (isLintCommand(currentSandboxCmd) && isSuccessfulSandboxResult(output)) {
            sawSuccessfulLintCommand = true
          }
        }

        // Auto-append "never make this mistake again" notes when a tool returns a structured failure.
        const out = output as any
        const isFailure = out && typeof out === 'object' && (out.ok === false || out.error)
        if (workspaceFsBackend && isFailure) {
          const hint = deriveHint(currentToolName, currentToolInput, out)
          const msg = [
            currentToolName ? `tool=${currentToolName}` : null,
            out.exitCode != null ? `exitCode=${String(out.exitCode)}` : null,
            out.error ? String(out.error) : null,
            out.stderr ? String(out.stderr).slice(0, 200) : null,
            currentToolInput ? `input=${currentToolInput.slice(0, 200)}` : null,
            hint ? `hint=${hint}` : null,
          ]
            .filter(Boolean)
            .join(' | ')
          if (msg && msg !== lastAppendedNote) {
            lastAppendedNote = msg
            void appendAgentsNote({ backend: workspaceFsBackend, note: msg }).catch(() => {})
          }
        }
      },
      handleToolError(error: Error, runId: string) {
        if (params.signal?.aborted) return
        params.onEvent?.({
          type: 'tool',
          payload: { phase: 'error', runPhase: currentWorkflowPhase, runId, error: error.message },
        })

        if (workspaceFsBackend) {
          const hint = deriveHint(currentToolName, currentToolInput, undefined, error.message)
          const msg = [
            currentToolName ? `tool=${currentToolName}` : null,
            `tool_error: ${error.message}`,
            currentToolInput ? `input=${currentToolInput.slice(0, 200)}` : null,
            hint ? `hint=${hint}` : null,
          ]
            .filter(Boolean)
            .join(' | ')
          if (msg !== lastAppendedNote) {
            lastAppendedNote = msg
            void appendAgentsNote({ backend: workspaceFsBackend, note: msg }).catch(() => {})
          }
        }
      },
    },
  ]

  const toolSchemaRetriesRaw = process.env.AGENT_TOOL_SCHEMA_RETRIES
  const toolSchemaRetriesNum = toolSchemaRetriesRaw ? Number(toolSchemaRetriesRaw) : NaN
  const toolSchemaRetries = Number.isFinite(toolSchemaRetriesNum)
    ? Math.max(0, Math.min(5, Math.trunc(toolSchemaRetriesNum)))
    : 2

  const isToolSchemaError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('Received tool input did not match expected schema')
  }

  const invokeWithSchemaRetry = async (messages: unknown[], phase: 'plan' | 'build') => {
    let nextMessages = messages
    const phaseTimeoutMs = phase === 'plan' ? planPhaseTimeoutMs : buildPhaseTimeoutMs
    for (let attempt = 0; attempt <= toolSchemaRetries; attempt++) {
      throwIfAborted(params.signal)
      try {
        const invokeAbort = new AbortController()
        let parentAbortListener: (() => void) | null = null
        if (params.signal) {
          if (params.signal.aborted) {
            invokeAbort.abort()
          } else {
            parentAbortListener = () => invokeAbort.abort()
            params.signal.addEventListener('abort', parentAbortListener, { once: true })
          }
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            invokeAbort.abort()
            reject(new Error(`agent ${phase} phase timed out after ${phaseTimeoutMs}ms`))
          }, phaseTimeoutMs)
        })

        const invokeConfig: RunnableConfig = {
          callbacks,
          runName: `deep-agent-run-${phase}`,
          runId,
          tags: [...invokeTags, `phase:${phase}`],
          metadata: { ...invokeMetadata, phase },
          signal: invokeAbort.signal,
        }

        const result = (await Promise.race([
          (agent as any).invoke({ messages: nextMessages } as any, invokeConfig) as Promise<{
            messages?: unknown[]
          }>,
          timeoutPromise,
        ]).finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (parentAbortListener && params.signal) {
            params.signal.removeEventListener('abort', parentAbortListener)
          }
        })) as { messages?: unknown[] }

        return result.messages ?? nextMessages
      } catch (err) {
        if (attempt < toolSchemaRetries && isToolSchemaError(err)) {
          const msg = err instanceof Error ? err.message : String(err)
          nextMessages = [
            ...nextMessages,
            {
              role: 'user',
              content:
                'A tool call failed schema validation. Retry the last step using the correct tool schema.\n\n' +
                `Error:\n${msg}\n\n` +
                'Reminder: when calling write_file, you must include both file_path and content as a string.',
            },
          ]
          continue
        }
        throw err
      }
    }
    return nextMessages
  }

  const runSandboxCommand = async (cmd: string) => {
    throwIfAborted(params.signal)
    if (!sandbox) {
      return {
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: '',
        error: 'Sandbox is unavailable.',
      }
    }

    const cwd = process.env.SANDBOX_APP_DIR || '/home/user'
    const timeoutMs = resolveAutoLintTimeoutMs(process.env.AUTO_LINT_TIMEOUT_MS)
    try {
      const result = await runSandboxCommandWithTimeout(sandbox, cmd, { cwd, timeoutMs })
      throwIfAborted(params.signal)
      return toSandboxCmdResult({
        ok: true,
        exitCode: (result as any).exitCode ?? 0,
        stdout: (result as any).stdout ?? '',
        stderr: (result as any).stderr ?? '',
      })
    } catch (err) {
      const result = (err as any)?.result
      if (result && typeof result.exitCode === 'number') {
        return toSandboxCmdResult({
          ok: false,
          exitCode: result.exitCode,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          error: result.error ?? (err instanceof Error ? err.message : String(err)),
        })
      }
      return toSandboxCmdResult({
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const t0 = Date.now()
  try {
    throwIfAborted(params.signal)
    let messages: unknown[] = [
      {
        role: 'user',
        content: buildPlanPhaseMessage(params.prompt, params.input),
      },
    ]
    let planSnapshot: PlanSnapshot | undefined

    currentWorkflowPhase = 'plan'
    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'phase_started',
        runId,
        phase: 'plan',
      },
    })
    messages = await invokeWithSchemaRetry(messages, 'plan')

    const planRaw = extractAssistantOutput(messages)
    planSnapshot = parsePlanSnapshot(planRaw) ?? buildFallbackPlan(planRaw, params.prompt)

    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'phase_completed',
        runId,
        phase: 'plan',
      },
    })
    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'plan_ready',
        runId,
        phase: 'plan',
        summary: planSnapshot.summary,
        todos: planSnapshot.todos,
      },
    })
    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'phase_transition',
        runId,
        from: 'plan',
        to: 'build',
      },
    })

    messages = [
      ...messages,
      {
        role: 'user',
        content: buildBuildPhaseMessage(planSnapshot),
      },
    ]

    currentWorkflowPhase = 'build'
    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'phase_started',
        runId,
        phase: 'build',
      },
    })
    messages = await invokeWithSchemaRetry(messages, 'build')
    params.onEvent?.({
      type: 'status',
      payload: {
        status: 'phase_completed',
        runId,
        phase: 'build',
      },
    })

    if (
      shouldAutoLintAfterBuild({
        workspaceMode,
        sawBuild: sawSuccessfulBuildCommand,
        enabledRaw: process.env.AUTO_LINT_AFTER_BUILD,
      })
    ) {
      const maxFixPasses = resolveAutoLintMaxPasses(process.env.AUTO_LINT_FIX_MAX_PASSES)
      let autoLintAttempt = 0
      let lintResult = await runSandboxCommand('bun run lint')

      params.onEvent?.({
        type: 'status',
        payload: {
          status: 'auto_lint_started',
          runId,
          cmd: 'bun run lint',
          maxFixPasses,
          initialExitCode: lintResult.exitCode,
        },
      })

      while (!(lintResult.ok && lintResult.exitCode === 0) && autoLintAttempt < maxFixPasses) {
        throwIfAborted(params.signal)
        autoLintAttempt += 1
        const lintSummary = formatLintFailureForModel({
          result: lintResult,
          cmd: 'bun run lint',
        })
        messages = [
          ...messages,
          {
            role: 'user',
            content:
              'Build succeeded, but lint failed. Fix the lint errors now. ' +
              'Use sandbox_cmd and run `bun run lint` after your fixes; it must exit with code 0.\n\n' +
              `Latest lint output:\n\n${lintSummary}`,
          },
        ]

        params.onEvent?.({
          type: 'status',
          payload: {
            status: 'auto_lint_fix_attempt',
            runId,
            attempt: autoLintAttempt,
            exitCode: lintResult.exitCode,
          },
        })

        messages = await invokeWithSchemaRetry(messages, 'build')
        lintResult = await runSandboxCommand('bun run lint')
      }

      if (lintResult.ok && lintResult.exitCode === 0) {
        sawSuccessfulLintCommand = true
        params.onEvent?.({
          type: 'status',
          payload: {
            status: 'auto_lint_passed',
            runId,
            attempts: autoLintAttempt,
            exitCode: lintResult.exitCode,
          },
        })
      } else {
        params.onEvent?.({
          type: 'status',
          payload: {
            status: 'auto_lint_failed',
            runId,
            attempts: autoLintAttempt,
            exitCode: lintResult.exitCode,
            error: lintResult.error ?? null,
          },
        })
      }
    }

    const t1 = Date.now()

    const { usage, cachedInputTokens, reasoningOutputTokens } = (() => {
      let inputTokens = 0
      let outputTokens = 0
      let totalTokens = 0
      let cachedInputTokens = 0
      let reasoningOutputTokens = 0

      for (const m of messages as any[]) {
        const u = (m as any)?.usage_metadata ?? (m as any)?.usageMetadata
        if (!u) continue
        const i = Number(u.input_tokens ?? u.inputTokens ?? 0)
        const o = Number(u.output_tokens ?? u.outputTokens ?? 0)
        const t = Number(u.total_tokens ?? u.totalTokens ?? 0)
        const inputDetails = (u.input_token_details ?? u.inputTokenDetails) as any
        const outputDetails = (u.output_token_details ?? u.outputTokenDetails) as any
        const cached = Number(inputDetails?.cache_read ?? inputDetails?.cacheRead ?? 0)
        const reasoning = Number(outputDetails?.reasoning ?? 0)
        if (Number.isFinite(i)) inputTokens += i
        if (Number.isFinite(o)) outputTokens += o
        if (Number.isFinite(t)) totalTokens += t
        if (Number.isFinite(cached)) cachedInputTokens += cached
        if (Number.isFinite(reasoning)) reasoningOutputTokens += reasoning
      }

      if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
        totalTokens = inputTokens + outputTokens
      }

      return {
        usage: { inputTokens, outputTokens, totalTokens },
        cachedInputTokens,
        reasoningOutputTokens,
      }
    })()
    const output = extractAssistantOutput(messages)

    const maxOutput = Number(process.env.MAX_OUTPUT_CHARS || 0)
    const finalOutput =
      maxOutput > 0 && output.length > maxOutput
        ? `${output.slice(0, maxOutput)}\n\n[truncated]`
        : output

    params.onEvent?.({
      type: 'status',
      payload: {
        ...(workspaceMode === 'host'
          ? {
              status: 'rollback_snapshot',
              runId,
              touchedFiles: rollback!.getTouchedFiles(),
              usage,
              cachedInputTokens,
              reasoningOutputTokens,
              durationMs: t1 - t0,
            }
          : {
              status: 'sandbox_snapshot',
              runId,
              sandboxId,
              downloadPath: sandboxId ? `/v1/sandbox/${sandboxId}/download.zip` : null,
              legacyDownloadPath: sandboxId ? `/sandbox/${sandboxId}/download.zip` : null,
              touchedFiles: touchedFiles ? Array.from(touchedFiles.values()) : [],
              lintPassed: sawSuccessfulBuildCommand ? sawSuccessfulLintCommand : null,
              usage,
              cachedInputTokens,
              reasoningOutputTokens,
              durationMs: t1 - t0,
            }),
      },
    })

    throwIfAborted(params.signal)

    return {
      output: finalOutput,
      messages,
      plan: planSnapshot,
      model: resolvedModelName,
      provider: selection.provider,
      modelSource: selection.source,
      sandboxId,
      usage,
      cachedInputTokens,
      reasoningOutputTokens,
      durationMs: t1 - t0,
    }
  } catch (err) {
    // User-canceled runs should not produce "never make this mistake again" notes.
    if (workspaceFsBackend && !isRunAbortedError(err)) {
      const msg = `run_error: ${err instanceof Error ? err.message : String(err)}`
      void appendAgentsNote({ backend: workspaceFsBackend, note: msg }).catch(() => {})
    }
    throw err
  } finally {
    // Best-effort "final snapshot" commit for E2B workspace zips (even on cancel/error/abort).
    // This allows external harnesses to validate version control is working inside the downloaded zip.
    if (workspaceMode === 'e2b' && sandbox) {
      try {
        const appDir = process.env.SANDBOX_APP_DIR || '/home/user'
        const git = (sandbox as unknown as { git?: unknown }).git
        if (git && typeof (git as { init?: unknown }).init === 'function') {
          const gitApi = git as {
            init: (path: string) => Promise<unknown>
            configureUser?: (name: string, email: string, opts?: { scope?: string; path?: string }) => Promise<unknown>
            add?: (path: string, opts?: { all?: boolean }) => Promise<unknown>
            commit?: (path: string, message: string, opts?: { allowEmpty?: boolean }) => Promise<unknown>
          }
          const authorName = process.env.AGENT_GIT_AUTHOR_NAME || 'Etlaq Agent'
          const authorEmail = process.env.AGENT_GIT_AUTHOR_EMAIL || 'agent@local'

          await gitApi.init(appDir).catch(() => undefined)
          if (typeof gitApi.configureUser === 'function') {
            await gitApi.configureUser(authorName, authorEmail, { scope: 'local', path: appDir }).catch(() => undefined)
          }
          if (typeof gitApi.add === 'function') {
            await gitApi.add(appDir, { all: true }).catch(() => undefined)
          }
          if (typeof gitApi.commit === 'function') {
            await gitApi.commit(appDir, `chore: snapshot run ${runId}`, { allowEmpty: true }).catch(() => undefined)
          }
        }
      } catch {
        // ignore
      }
    }

    if (mcpClient) {
      const closeFn = (mcpClient as unknown as { close?: () => Promise<void> }).close
      if (closeFn) {
        await closeFn.call(mcpClient)
      }
    }
  }
}
