import { api } from 'encore.dev/api'
import { CronJob } from 'encore.dev/cron'
import { enqueueRun } from './queue'
import { requeueStaleRunningJobs, resolveRequeueRunningAfterSeconds, updateRunStatus } from '../data/db'

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

export { _requeueStaleRunsCron }
