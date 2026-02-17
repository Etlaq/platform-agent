import { api } from 'encore.dev/api'
import { apiSuccess, type ApiSuccess } from '../common/apiContract'
import { getJobsStatusCounts, getRunsStatusCounts } from '../data/db'

import '../auth/auth'

interface MetricsSnapshot {
  runs: Array<{ status: string; count: number }>
  jobs: Array<{ status: string; count: number }>
}

async function readMetricsSnapshot(): Promise<MetricsSnapshot> {
  const [runsCounts, jobsCounts] = await Promise.all([
    getRunsStatusCounts(),
    getJobsStatusCounts(),
  ])

  return {
    runs: runsCounts,
    jobs: jobsCounts,
  }
}

function toPrometheusLines(snapshot: MetricsSnapshot) {
  const lines: string[] = []
  for (const row of snapshot.runs) {
    lines.push(`runs_status{status="${row.status}"} ${row.count}`)
  }

  for (const row of snapshot.jobs) {
    lines.push(`jobs_status{status="${row.status}"} ${row.count}`)
  }

  return lines
}

export const metrics = api.raw(
  { method: 'GET', path: '/metrics', expose: true, auth: true },
  async (_req, res) => {
    const snapshot = await readMetricsSnapshot()
    const lines = toPrometheusLines(snapshot)

    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(lines.join('\n') || 'database_enabled')
  },
)

export const metricsV1 = api(
  { method: 'GET', path: '/v1/metrics', expose: true, auth: true },
  async (): Promise<ApiSuccess<MetricsSnapshot>> => apiSuccess(await readMetricsSnapshot()),
)

export const metricsPrometheusV1 = api.raw(
  { method: 'GET', path: '/v1/metrics/prometheus', expose: true, auth: true },
  async (_req, res) => {
    const snapshot = await readMetricsSnapshot()
    const lines = toPrometheusLines(snapshot)

    res.statusCode = 200
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(lines.join('\n') || 'database_enabled')
  },
)
