import { api } from 'encore.dev/api'
import { CAPABILITY_ACTIONS, CAPABILITY_ENV, readPackageName } from '../common/capabilities'

// Ensure auth gateway and cron declarations are loaded.
import '../auth/auth'
import '../worker/cron'

interface RootResponse {
  name: string
  status: string
  endpoints: string[]
}

interface HealthResponse {
  status: string
  ts: string
}

interface CapabilitiesResponse {
  name: string
  actions: string[]
  constraints: {
    nextOnly: boolean
    bunOnly: boolean
    noArbitraryShell: boolean
    secrets: {
      readDotEnvDenied: boolean
      envExampleReadable: boolean
      envExampleSyncAvailable: boolean
    }
  }
  env: Record<string, string>
}

export const root = api(
  { method: 'GET', path: '/', expose: true, auth: true },
  async (): Promise<RootResponse> => ({
    name: 'etlaq-agent-backend-v2',
    status: 'ok',
    endpoints: [
      '/health',
      '/capabilities',
      '/runs',
      '/exec',
      '/download.zip',
      '/sandbox/create',
      '/sandbox/info',
      '/sandbox/dev/start',
      '/sandbox/dev/stop',
      '/metrics',
    ],
  }),
)

export const health = api(
  { method: 'GET', path: '/health', expose: true },
  async (): Promise<HealthResponse> => ({
    status: 'ok',
    ts: new Date().toISOString(),
  }),
)

export const capabilities = api(
  { method: 'GET', path: '/capabilities', expose: true, auth: true },
  async (): Promise<CapabilitiesResponse> => ({
    name: readPackageName(),
    actions: [...CAPABILITY_ACTIONS],
    constraints: {
      nextOnly: true,
      bunOnly: true,
      noArbitraryShell: true,
      secrets: {
        readDotEnvDenied: true,
        envExampleReadable: true,
        envExampleSyncAvailable: true,
      },
    },
    env: CAPABILITY_ENV,
  }),
)
