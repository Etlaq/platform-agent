import { Topic, Subscription } from 'encore.dev/pubsub'
import {
  cancelJobByRunId,
  completeRun,
  failRun,
  getJobByRunId,
  getRun,
  insertEventWithNextSeq,
  markJobFailed,
  queueRunForRetry,
  setJobStatus,
  updateRunStatus,
} from '../data/db'
import { isRunAbortedError, runAgent } from '../agent/runAgent'
import { commitRunToGit } from './gitCommit'

interface RunRequestedEvent {
  runId: string
}

const POLL_CANCEL_MS = 750

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

async function processRun(runId: string) {
  const baseRun = await getRun(runId)
  if (!baseRun) return

  let attempts = (await getJobByRunId(runId))?.attempts ?? 0
  const maxAttempts = (await getJobByRunId(runId))?.maxAttempts ?? 3

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

    await updateRunStatus(runId, 'running')
    await setJobStatus(runId, 'running')
    await emit(runId, 'status', { status: 'running' })

    const abortController = new AbortController()
    let cancelWatch: ReturnType<typeof setInterval> | null = null
    let cancelCheckInFlight = false
    let eventChain = Promise.resolve()

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

      const result = await runAgent({
        prompt: latestRun.prompt,
        input: latestRun.input ?? undefined,
        provider: latestRun.provider ?? undefined,
        model: latestRun.model ?? undefined,
        runId,
        workspaceBackend: latestRun.workspaceBackend ?? undefined,
        signal: abortController.signal,
        onEvent: (event) => {
          if (abortController.signal.aborted) return
          if (event.type === 'token') {
            queueEmit('token', event.payload)
            return
          }
          if (event.type === 'tool') {
            queueEmit('tool', event.payload)
            return
          }
          if (event.type === 'status') {
            queueEmit('status', event.payload)
          }
        },
      })

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
        usage: result.usage,
        durationMs: result.durationMs,
      })
      await emit(runId, 'done', {
        output: result.output,
        usage: result.usage,
        durationMs: result.durationMs,
      })
      await setJobStatus(runId, 'succeeded')

      if (runAfterModel?.status !== 'cancelled') {
        const gitCommit = await commitRunToGit({
          runId,
          workspaceBackend: runAfterModel?.workspaceBackend ?? latestRun.workspaceBackend ?? null,
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
    }
  }
}

const _runRequestedSubscription = new Subscription(runRequestedTopic, 'process-run', {
  handler: async ({ runId }) => {
    await processRun(runId)
  },
})

export { _runRequestedSubscription }
