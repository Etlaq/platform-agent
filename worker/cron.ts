import { api } from 'encore.dev/api'
import { CronJob } from 'encore.dev/cron'
import { enqueueRun } from './queue'
import {
  listRunnableQueuedJobRunIds,
  requeueStaleRunningJobs,
  resolveWorkerKickQueuedLimit,
  resolveWorkerKickQueuedMinAgeSeconds,
  resolveRequeueRunningAfterSeconds,
  updateRunStatus,
} from '../data/db'

export const requeueStaleRuns = api(
  { expose: false },
  async (): Promise<void> => {
    const staleSeconds = resolveRequeueRunningAfterSeconds()
    if (staleSeconds <= 0) return

    const runIds = await requeueStaleRunningJobs(staleSeconds)
    for (const runId of runIds) {
      await updateRunStatus(runId, 'queued')
      await enqueueRun(runId)
    }
  }
)

const _requeueStaleRunsCron = new CronJob('requeue-stale-runs', {
  title: 'Requeue stale running jobs',
  every: '1m',
  endpoint: requeueStaleRuns,
})

export const kickQueuedRuns = api(
  { expose: false },
  async (): Promise<{ ok: true; enqueued: number; runIds: string[] }> => {
    const limit = resolveWorkerKickQueuedLimit()
    const minAgeSeconds = resolveWorkerKickQueuedMinAgeSeconds()

    const runIds = await listRunnableQueuedJobRunIds({ limit, minQueuedAgeSeconds: minAgeSeconds })
    for (const runId of runIds) {
      await enqueueRun(runId)
    }

    return { ok: true, enqueued: runIds.length, runIds }
  }
)

const _kickQueuedRunsCron = new CronJob('kick-queued-runs', {
  title: 'Kick queued runs',
  every: '1m',
  endpoint: kickQueuedRuns,
})

export { _requeueStaleRunsCron, _kickQueuedRunsCron }
