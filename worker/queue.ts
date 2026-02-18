import { Topic, Subscription } from 'encore.dev/pubsub'
import { secret } from 'encore.dev/config'
import {
  addArtifact,
  cancelJobByRunId,
  completeRun,
  failRun,
  getJobByRunId,
  getRun,
  claimRunForExecution,
  insertEventWithNextSeq,
  markJobFailed,
  queueRunForRetry,
  setRunExecutionAttempt,
  setRunSandboxId,
  setRunWorkspaceBackend,
  setJobStatus,
  updateRunMeta,
  updateRunStatus,
} from '../data/db'
import { isRunAbortedError, runAgent, RunAbortedError } from '../agent/runAgent'
import { commitRunToGit } from './gitCommit'
import { connectSandboxWithRetry, closeSandboxWithRetry } from '../common/e2bSandbox'
import { resolveSandboxAppDir } from '../common/e2b'
import { buildSandboxZipBuffer } from '../common/sandboxZip'

interface RunRequestedEvent {
  runId: string
}

const POLL_CANCEL_MS = 750

const agentProviderSecrets = [secret('AGENT_PROVIDER'), secret('AgentProvider')]
const zaiApiKeySecrets = [secret('ZAI_API_KEY'), secret('ZaiApiKey')]
const zaiModelSecrets = [secret('ZAI_MODEL'), secret('ZaiModel')]
const anthropicApiKeySecrets = [secret('ANTHROPIC_API_KEY'), secret('AnthropicApiKey')]
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
      // Existing runtime checks surface clear errors when required values are absent.
    }
  }
}

function hydrateWorkerEnvFromSecrets() {
  setFromSecretsIfMissing('AGENT_PROVIDER', agentProviderSecrets)
  setFromSecretsIfMissing('ZAI_API_KEY', zaiApiKeySecrets)
  setFromSecretsIfMissing('ZAI_MODEL', zaiModelSecrets)
  setFromSecretsIfMissing('ANTHROPIC_API_KEY', anthropicApiKeySecrets)
  setFromSecretsIfMissing('E2B_API_KEY', e2bApiKeySecrets)
  setFromSecretsIfMissing('E2B_TEMPLATE', e2bTemplateSecrets)
}

function parsePositiveInt(name: string, fallback: number, opts?: { min?: number; max?: number }) {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  const min = opts?.min ?? 1
  const max = opts?.max ?? Number.MAX_SAFE_INTEGER
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

const MAX_BACKOFF_SECONDS = parsePositiveInt('WORKER_MAX_BACKOFF', 30, { min: 1, max: 600 })
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export const runRequestedTopic = new Topic<RunRequestedEvent>('run-requested', {
  deliveryGuarantee: 'at-least-once',
})

export async function enqueueRun(runId: string) {
  await runRequestedTopic.publish({ runId })
}

async function emit(runId: string, type: string, payload: unknown) {
  await insertEventWithNextSeq({ runId, type, payload })
}

function parseSandboxIdFromStatusPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const status = (payload as { status?: unknown }).status
  if (status !== 'sandbox_created' && status !== 'sandbox_snapshot') return null
  const sandboxId = (payload as { sandboxId?: unknown }).sandboxId
  if (typeof sandboxId !== 'string') return null
  const trimmed = sandboxId.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseWorkspaceBackend(raw: unknown): 'host' | 'e2b' | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'host' || normalized === 'e2b') return normalized
  return null
}

function resolveWorkspaceBackend(preferred: 'host' | 'e2b' | null | undefined): 'host' | 'e2b' {
  const explicit = parseWorkspaceBackend(preferred)
  if (explicit) return explicit

  const envChoice =
    parseWorkspaceBackend(process.env.AGENT_WORKSPACE_BACKEND) ??
    parseWorkspaceBackend(process.env.WORKSPACE_BACKEND)
  if (envChoice) return envChoice

  if (normalizeSecret(process.env.E2B_API_KEY) && normalizeSecret(process.env.E2B_TEMPLATE)) {
    return 'e2b'
  }

  return 'host'
}

async function closeSandboxIfPresent(sandboxId: string | null | undefined) {
  if (!sandboxId) return
  try {
    await closeSandboxWithRetry(sandboxId)
  } catch (error) {
    console.error('queue: failed to close sandbox', error)
  }
}

async function persistSandboxWorkspaceArtifact(runId: string, sandboxId: string | null | undefined) {
  if (!sandboxId) return null

  try {
    const { putBinaryObject } = await import('../storage/storage')
    const sb = await connectSandboxWithRetry(sandboxId)
    const appDir = resolveSandboxAppDir()
    const { buffer, fileCount } = await buildSandboxZipBuffer(sb, appDir)
    const key = `runs/${runId}/workspace.zip`
    await putBinaryObject(key, buffer, 'application/zip')
    await addArtifact({
      runId,
      name: 'workspace.zip',
      path: key,
      mime: 'application/zip',
      size: buffer.length,
    })

    return { key, size: buffer.length, fileCount }
  } catch (error) {
    console.error('queue: failed to persist sandbox workspace artifact', error)
    return null
  }
}

async function processRun(runId: string) {
  hydrateWorkerEnvFromSecrets()

  const baseRun = await getRun(runId)
  if (!baseRun) return

  const parseNumber = (value: unknown) => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : null
  }

  const parseSnapshotMeta = (payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const status = (payload as { status?: unknown }).status
    if (status !== 'rollback_snapshot' && status !== 'sandbox_snapshot') return null

    const usageRaw = (payload as { usage?: unknown }).usage
    const usage = (() => {
      if (!usageRaw || typeof usageRaw !== 'object' || Array.isArray(usageRaw)) return null
      const inputTokens = parseNumber((usageRaw as { inputTokens?: unknown }).inputTokens) ?? 0
      const outputTokens = parseNumber((usageRaw as { outputTokens?: unknown }).outputTokens) ?? 0
      const totalRaw = parseNumber((usageRaw as { totalTokens?: unknown }).totalTokens)
      const totalTokens =
        totalRaw == null || (totalRaw === 0 && (inputTokens > 0 || outputTokens > 0))
          ? inputTokens + outputTokens
          : totalRaw
      return { inputTokens, outputTokens, totalTokens }
    })()

    return {
      ...(usage ? { usage } : {}),
      cachedInputTokens: parseNumber((payload as { cachedInputTokens?: unknown }).cachedInputTokens) ?? undefined,
      reasoningOutputTokens: parseNumber((payload as { reasoningOutputTokens?: unknown }).reasoningOutputTokens) ?? undefined,
      durationMs: parseNumber((payload as { durationMs?: unknown }).durationMs) ?? undefined,
    }
  }

  const job = await getJobByRunId(runId)
  let attempts = job?.attempts ?? 0
  const maxAttempts = job?.maxAttempts ?? 3

  // Keep retry logic inside the handler to preserve deterministic event order.
  while (attempts < maxAttempts) {
    const latestRun = await getRun(runId)
    if (!latestRun) return

    if (latestRun.status === 'cancelled') {
      await cancelJobByRunId(runId)
      return
    }

    if (latestRun.status === 'completed' || latestRun.status === 'error') {
      return
    }

    const claimed = await claimRunForExecution(runId)
    if (!claimed) return

    const workspaceBackend = resolveWorkspaceBackend(latestRun.workspaceBackend)
    if (latestRun.workspaceBackend !== workspaceBackend) {
      await setRunWorkspaceBackend(runId, workspaceBackend).catch((error) => {
        console.error('queue: failed to persist workspace backend', error)
      })
    }

    const currentAttempt = attempts + 1
    await setRunExecutionAttempt(runId, currentAttempt, maxAttempts)
    await updateRunStatus(runId, 'running')
    await emit(runId, 'status', { status: 'running' })

    const abortController = new AbortController()
    let cancelWatch: ReturnType<typeof setInterval> | null = null
    let cancelCheckInFlight = false
    let eventChain = Promise.resolve()
    let attemptSandboxId: string | null = latestRun.sandboxId ?? null

    const queueEmit = (type: string, payload: unknown) => {
      eventChain = eventChain
        .then(async () => {
          await emit(runId, type, payload)
        })
        .catch((error) => {
          console.error('queue: failed to emit event', error)
        })
    }

    try {
      cancelWatch = setInterval(() => {
        if (cancelCheckInFlight || abortController.signal.aborted) return
        cancelCheckInFlight = true
        void getRun(runId)
          .then((run) => {
            if (run?.status === 'cancelled') {
              abortController.abort()
            }
          })
          .catch((error) => {
            console.error('queue: cancellation check failed', error)
          })
          .finally(() => {
            cancelCheckInFlight = false
          })
      }, POLL_CANCEL_MS)

      // Ensure a cancelled run doesn't keep the PubSub handler stuck waiting forever if the
      // underlying model/tool call ignores AbortSignal (we still pass the signal through).
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (abortController.signal.aborted) {
          reject(new RunAbortedError())
          return
        }
        abortController.signal.addEventListener(
          'abort',
          () => reject(new RunAbortedError()),
          { once: true },
        )
      })

      const result = await Promise.race([
        runAgent({
          prompt: latestRun.prompt,
          input: latestRun.input ?? undefined,
          provider: latestRun.provider ?? undefined,
          model: latestRun.model ?? undefined,
          runId,
          workspaceBackend,
          signal: abortController.signal,
          onEvent: (event) => {
            if (abortController.signal.aborted) return
            if (event.type === 'token') {
              queueEmit('token', event.payload)
              return
            }
            if (event.type === 'file_op') {
              queueEmit('file_op', event.payload)
              return
            }
            if (event.type === 'tool') {
              queueEmit('tool', event.payload)
              return
            }
            if (event.type === 'status') {
              const sandboxId = parseSandboxIdFromStatusPayload(event.payload)
              if (sandboxId && sandboxId !== attemptSandboxId) {
                attemptSandboxId = sandboxId
                void setRunSandboxId(runId, sandboxId).catch((error) => {
                  console.error('queue: failed to persist sandbox id', error)
                })
              }

              const meta = parseSnapshotMeta(event.payload)
              if (meta) {
                void updateRunMeta(runId, meta).catch((error) => {
                  console.error('queue: failed to persist run meta', error)
                })
              }
              queueEmit('status', event.payload)
            }
          },
        }),
        abortPromise,
      ])
      if (result.sandboxId && result.sandboxId !== attemptSandboxId) {
        attemptSandboxId = result.sandboxId
        await setRunSandboxId(runId, result.sandboxId).catch((error) => {
          console.error('queue: failed to persist run sandbox id', error)
        })
      }
      await eventChain

      const runAfterModel = await getRun(runId)
      const cancelled = abortController.signal.aborted || runAfterModel?.status === 'cancelled'

      if (cancelled) {
        await cancelJobByRunId(runId)
        return
      }

      await emit(runId, 'status', {
        status: 'model_resolved',
        provider: result.provider,
        model: result.model,
        source: result.modelSource,
      })

      await completeRun(runId, result.output, {
        provider: result.provider,
        model: result.model,
        modelSource: result.modelSource,
        usage: result.usage,
        cachedInputTokens: result.cachedInputTokens,
        reasoningOutputTokens: result.reasoningOutputTokens,
        durationMs: result.durationMs,
      })
      await emit(runId, 'done', {
        output: result.output,
        usage: result.usage,
        cachedInputTokens: result.cachedInputTokens,
        reasoningOutputTokens: result.reasoningOutputTokens,
        durationMs: result.durationMs,
      })
      await setJobStatus(runId, 'succeeded')

      if (runAfterModel?.status !== 'cancelled') {
        const gitCommit = await commitRunToGit({
          runId,
          workspaceBackend,
        })

        if (gitCommit.ok) {
          await emit(runId, 'status', {
            status: 'git_commit',
            runId,
            commitSha: gitCommit.commitSha ?? null,
          })
        } else if (gitCommit.error) {
          await emit(runId, 'status', {
            status: 'git_commit_error',
            runId,
            error: gitCommit.error,
          })
        } else if (gitCommit.skipped) {
          await emit(runId, 'status', {
            status: 'git_commit_skipped',
            runId,
            reason: gitCommit.skipped,
          })
        }
      }

      if (workspaceBackend === 'e2b') {
        const snapshot = await persistSandboxWorkspaceArtifact(runId, attemptSandboxId)
        if (snapshot) {
          await emit(runId, 'status', {
            status: 'workspace_snapshot_stored',
            artifactPath: snapshot.key,
            sizeBytes: snapshot.size,
            fileCount: snapshot.fileCount,
          })
        } else {
          await emit(runId, 'status', {
            status: 'workspace_snapshot_store_failed',
          })
        }
      }

      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await eventChain

      const runAfterError = await getRun(runId)
      const cancelled =
        abortController.signal.aborted || runAfterError?.status === 'cancelled' || isRunAbortedError(error)

      if (cancelled) {
        await cancelJobByRunId(runId)
        return
      }

      attempts += 1
      const delaySeconds = Math.min(MAX_BACKOFF_SECONDS, 2 ** attempts)
      const finalAttempt = attempts >= maxAttempts

      if (finalAttempt) {
        if (workspaceBackend === 'e2b') {
          const snapshot = await persistSandboxWorkspaceArtifact(runId, attemptSandboxId)
          if (snapshot) {
            await emit(runId, 'status', {
              status: 'workspace_snapshot_stored',
              artifactPath: snapshot.key,
              sizeBytes: snapshot.size,
              fileCount: snapshot.fileCount,
            })
          } else {
            await emit(runId, 'status', {
              status: 'workspace_snapshot_store_failed',
            })
          }
        }

        await failRun(runId, message)
        await emit(runId, 'error', {
          error: message,
          attempts,
          maxAttempts,
        })
        await setJobStatus(runId, 'failed')
        return
      }

      await queueRunForRetry(runId)
      await markJobFailed(runId, attempts, delaySeconds)
      await emit(runId, 'status', {
        status: 'attempt_failed',
        error: message,
        attempts,
        maxAttempts,
      })
      await emit(runId, 'status', {
        status: 'retrying',
        nextAttempt: attempts + 1,
        backoffSeconds: delaySeconds,
      })

      await sleep(delaySeconds * 1000)
      continue
    } finally {
      if (cancelWatch) clearInterval(cancelWatch)
      await closeSandboxIfPresent(attemptSandboxId)
      if (attemptSandboxId) {
        await setRunSandboxId(runId, null).catch((error) => {
          console.error('queue: failed to clear run sandbox id', error)
        })
      }
    }
  }
}

const _runRequestedSubscription = new Subscription(runRequestedTopic, 'process-run', {
  handler: async ({ runId }) => {
    await processRun(runId)
  },
})

export { _runRequestedSubscription }
