import type { BackendProtocol } from 'deepagents'
import type { AgentEventCallback } from './events'
import { extractSandboxCmd, isBuildCommand, isLintCommand, isSuccessfulSandboxResult } from './autoLint'
import { appendAgentsNote } from './agentsMd'
import { asRecord, toNonEmptyString } from './planParser'

export interface CreateAgentCallbacksOptions {
  onEvent: AgentEventCallback | undefined
  signal: AbortSignal | undefined
  emitTokens: boolean
  runId: string
  getWorkflowPhase: () => 'plan' | 'build'
  getWorkspaceFsBackend: () => BackendProtocol | null
  onBuildCommandSuccess: () => void
  onLintCommandSuccess: () => void
  detectPlanMutationAttempt: (toolName: string, input: unknown) => string | null
}

export function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}

export function deriveHint(toolName: string, toolInput: string, out?: any, errMsg?: string) {
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

export function createAgentCallbacks(opts: CreateAgentCallbacksOptions) {
  let currentToolName = ''
  let currentToolInput = ''
  let currentSandboxCmd: string | null = null
  let lastAppendedNote = ''

  return {
    callbacks: [
      {
        handleLLMNewToken(token: string) {
          if (opts.signal?.aborted) return
          if (opts.emitTokens) {
            opts.onEvent?.({ type: 'token', payload: { token } })
          }
        },
        handleToolStart(tool: { name?: string }, input: unknown) {
          if (opts.signal?.aborted) return
          currentToolName = tool?.name ?? 'tool'
          currentToolInput = typeof input === 'string' ? input : safeStringify(input)
          currentSandboxCmd =
            currentToolName === 'sandbox_cmd' ? extractSandboxCmd(currentToolInput) : null
          opts.onEvent?.({
            type: 'tool',
            payload: {
              phase: 'start',
              runPhase: opts.getWorkflowPhase(),
              tool: tool?.name ?? 'tool',
              input,
            },
          })

          if (opts.getWorkflowPhase() === 'plan') {
            const mutation = opts.detectPlanMutationAttempt(currentToolName, input)
            if (mutation) {
              opts.onEvent?.({
                type: 'status',
                payload: {
                  status: 'plan_policy_warning',
                  runId: opts.runId,
                  phase: 'plan',
                  tool: currentToolName,
                  detail: mutation,
                },
              })
            }
          }
        },
        handleToolEnd(output: unknown, runId: string) {
          if (opts.signal?.aborted) return
          opts.onEvent?.({
            type: 'tool',
            payload: { phase: 'end', runPhase: opts.getWorkflowPhase(), runId, output },
          })

          if (opts.getWorkflowPhase() === 'build' && currentToolName === 'sandbox_cmd' && currentSandboxCmd) {
            if (isBuildCommand(currentSandboxCmd) && isSuccessfulSandboxResult(output)) {
              opts.onBuildCommandSuccess()
            }
            if (isLintCommand(currentSandboxCmd) && isSuccessfulSandboxResult(output)) {
              opts.onLintCommandSuccess()
            }
          }

          const out = output as any
          const isFailure = out && typeof out === 'object' && (out.ok === false || out.error)
          const workspaceFsBackend = opts.getWorkspaceFsBackend()
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
          if (opts.signal?.aborted) return
          opts.onEvent?.({
            type: 'tool',
            payload: { phase: 'error', runPhase: opts.getWorkflowPhase(), runId, error: error.message },
          })

          const workspaceFsBackend = opts.getWorkspaceFsBackend()
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
    ],
    getCurrentToolName: () => currentToolName,
    getCurrentSandboxCmd: () => currentSandboxCmd,
  }
}
