import { api } from 'encore.dev/api'
import { getJobsStatusCounts, getRunsStatusCounts } from '../data/db'

import '../auth/auth'

export const metrics = api.raw(
  { method: 'GET', path: '/metrics', expose: true, auth: true },
  async (_req, res) => {
    const runsCounts = await getRunsStatusCounts()
    const jobsCounts = await getJobsStatusCounts()

    const lines: string[] = []
    for (const row of runsCounts) {
      lines.push(`runs_status{status="${row.status}"} ${row.count}`)
    }

    for (const row of jobsCounts) {
      lines.push(`jobs_status{status="${row.status}"} ${row.count}`)
    }

    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(lines.join('\n') || 'database_enabled')
  },
)
