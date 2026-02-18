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
import { ObservableBackend } from './backends/observableBackend'
import { createProjectActionsTool } from './tools/projectActions'
import { createSandboxCmdTool } from './tools/sandboxCmd'
import { Sandbox } from '@e2b/code-interpreter'
import { createSandboxWithRetry, runSandboxCommandWithTimeout } from '../common/e2bSandbox'
import { resolveSandboxAppDir } from '../common/e2b'
import { appendAgentsNote, ensureAgentsMd, loadAgentsMdTemplate } from './agentsMd'
import {
  extractSandboxCmd,
  formatLintFailureForModel,
  resolveAutoLintMaxPasses,
  resolveAutoLintTimeoutMs,
  shouldAutoLintAfterBuild,
  toSandboxCmdResult,
} from './autoLint'
import {
  DEFAULT_MEMORY_DIR,
  DEFAULT_ROLLBACK_DIR,
  DEFAULT_SKILLS_DIR,
  DEFAULT_SUBAGENT_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  E2B_SYSTEM_PROMPT,
  ensureDir,
  resolveDir,
  resolveWorkspaceRoot,
} from './runtime/config'
import { loadMcpTools } from './runtime/mcp'
import { createModel, normalizeModelName } from './runtime/modelFactory'
import type { AgentEventCallback } from './events'
import { createAgentCallbacks } from './callbacks'
import { accumulateUsage } from './usage'
import { initSandboxGit, snapshotSandboxGit } from './sandboxGit'
import {
  type PlanSnapshot,
  type PlanTodoItem,
  parsePlanSnapshot,
  buildFallbackPlan,
  buildPlanPhaseMessage,
  buildBuildPhaseMessage,
  asRecord,
  toNonEmptyString,
} from './planParser'

// Re-export for external consumers (tests, worker)
export { parsePlanSnapshot }
export type { PlanSnapshot, PlanTodoItem }

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
  onEvent?: AgentEventCallback
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
  const planPhaseTimeoutMs = resolvePhaseTimeoutMs('AGENT_PLAN_PHASE_TIMEOUT_MS', 60 * 60_000)
  const buildPhaseTimeoutMs = resolvePhaseTimeoutMs('AGENT_BUILD_PHASE_TIMEOUT_MS', 10 * 60 * 60_000)
  const streamChunkMaxChars = (() => {
    const raw = process.env.E2B_STREAM_CHUNK_MAX_CHARS
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) return 2000
    return Math.max(200, Math.min(20_000, Math.trunc(n)))
  })()
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
  let currentWorkflowPhase: 'plan' | 'build' = 'plan'
  let sawSuccessfulBuildCommand = false
  let sawSuccessfulLintCommand = false

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
    const appDir = resolveSandboxAppDir()
    if (!apiKey) throw new Error('E2B_API_KEY is required for workspaceBackend=e2b.')
    if (!template) throw new Error('E2B_TEMPLATE is required for workspaceBackend=e2b.')

    const timeoutRaw = process.env.E2B_SANDBOX_TIMEOUT_MS
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : NaN
    const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2 * 60 * 60_000
    sandbox = await createSandboxWithRetry(
      template,
      { timeoutMs: effectiveTimeoutMs },
    )
    sandboxId = (sandbox as any).sandboxId

    await initSandboxGit(sandbox, appDir)

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

  const emitSandboxStreamChunk = (params2: {
    cmd: string
    stream: 'stdout' | 'stderr'
    chunk: string
    internal?: boolean
  }) => {
    if (params.signal?.aborted) return
    const raw = params2.chunk
    if (typeof raw !== 'string' || raw.length === 0) return

    for (let i = 0; i < raw.length; i += streamChunkMaxChars) {
      const chunk = raw.slice(i, i + streamChunkMaxChars)
      if (!chunk) continue
      params.onEvent?.({
        type: 'tool',
        payload: {
          phase: 'stream',
          runPhase: currentWorkflowPhase,
          tool: 'sandbox_cmd',
          cmd: params2.cmd,
          stream: params2.stream,
          internal: params2.internal ?? false,
          chunk,
        },
      })
    }
  }

  if (workspaceMode === 'e2b') {
    workspaceFsBackend = await e2bBackend()
    const appDir = resolveSandboxAppDir()
    if (sandbox) {
      tools.push(
        createSandboxCmdTool({
          sandbox,
          defaultCwd: appDir,
          onStdout: ({ cmd, chunk }) => {
            emitSandboxStreamChunk({ cmd, stream: 'stdout', chunk })
          },
          onStderr: ({ cmd, chunk }) => {
            emitSandboxStreamChunk({ cmd, stream: 'stderr', chunk })
          },
        }) as any
      )
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

  // Wrap workspace backend with ObservableBackend to emit file_op events
  const observedWorkspace = workspaceFsBackend
    ? new ObservableBackend(workspaceFsBackend, {
        onFileOp: (payload) => params.onEvent?.({ type: 'file_op', payload }),
        getPhase: () => currentWorkflowPhase,
      })
    : null

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

    return new CompositeBackend(wrappedBackend as any, {
      '/memories/': memoryBackend,
      '/skills/': skillsBackend,
      '/': (observedWorkspace ?? workspaceFsBackend) as any,
    })
  }

  const { callbacks } = createAgentCallbacks({
    onEvent: params.onEvent,
    signal: params.signal,
    emitTokens: params.emitTokens !== false,
    runId,
    getWorkflowPhase: () => currentWorkflowPhase,
    getWorkspaceFsBackend: () => workspaceFsBackend,
    onBuildCommandSuccess: () => { sawSuccessfulBuildCommand = true },
    onLintCommandSuccess: () => { sawSuccessfulLintCommand = true },
    detectPlanMutationAttempt,
  })

  const agent = createDeepAgent({
    model,
    tools: filteredTools as any,
    systemPrompt: workspaceMode === 'e2b' ? E2B_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT,
    backend: backendFactory,
    memory: ['/AGENTS.md'],
    skills: ['/skills/'],
    subagents: subagents as any,
  } as any)

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

    const cwd = resolveSandboxAppDir()
    const timeoutMs = resolveAutoLintTimeoutMs(process.env.AUTO_LINT_TIMEOUT_MS)
    try {
      const result = await runSandboxCommandWithTimeout(sandbox, cmd, {
        cwd,
        timeoutMs,
        onStdout: (chunk) => {
          emitSandboxStreamChunk({ cmd, stream: 'stdout', chunk, internal: true })
        },
        onStderr: (chunk) => {
          emitSandboxStreamChunk({ cmd, stream: 'stderr', chunk, internal: true })
        },
      })
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

    // --- Plan phase ---
    currentWorkflowPhase = 'plan'
    params.onEvent?.({
      type: 'status',
      payload: { status: 'phase_started', runId, phase: 'plan' },
    })
    messages = await invokeWithSchemaRetry(messages, 'plan')

    const planRaw = extractAssistantOutput(messages)
    planSnapshot = parsePlanSnapshot(planRaw) ?? buildFallbackPlan(planRaw, params.prompt)

    params.onEvent?.({
      type: 'status',
      payload: { status: 'phase_completed', runId, phase: 'plan' },
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
      payload: { status: 'phase_transition', runId, from: 'plan', to: 'build' },
    })

    // --- Build phase ---
    messages = [
      ...messages,
      { role: 'user', content: buildBuildPhaseMessage(planSnapshot) },
    ]

    currentWorkflowPhase = 'build'
    params.onEvent?.({
      type: 'status',
      payload: { status: 'phase_started', runId, phase: 'build' },
    })
    messages = await invokeWithSchemaRetry(messages, 'build')
    params.onEvent?.({
      type: 'status',
      payload: { status: 'phase_completed', runId, phase: 'build' },
    })

    // --- Optional auto-lint ---
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

    // --- Accumulate usage and return ---
    const t1 = Date.now()
    const { usage, cachedInputTokens, reasoningOutputTokens } = accumulateUsage(messages)
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
              touchedFiles: touchedFiles ? Array.from(touchedFiles) : [],
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
    if (workspaceFsBackend && !isRunAbortedError(err)) {
      const msg = `run_error: ${err instanceof Error ? err.message : String(err)}`
      void appendAgentsNote({ backend: workspaceFsBackend, note: msg }).catch(() => {})
    }
    throw err
  } finally {
    if (workspaceMode === 'e2b' && sandbox) {
      const appDir = resolveSandboxAppDir()
      await snapshotSandboxGit(sandbox, appDir, runId)
    }

    if (mcpClient) {
      const closeFn = (mcpClient as unknown as { close?: () => Promise<void> }).close
      if (closeFn) {
        await closeFn.call(mcpClient)
      }
    }
  }
}
