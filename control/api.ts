import { api } from 'encore.dev/api'
import { CAPABILITY_ACTIONS, CAPABILITY_ENV, readPackageName } from '../common/capabilities'
import { apiSuccess, API_VERSION, type ApiSuccess } from '../common/apiContract'

// Ensure auth gateway and cron declarations are loaded.
import '../auth/auth'
import '../worker/cron'

interface RootResponse {
  name: string
  status: string
  version: typeof API_VERSION
  docs: string[]
  endpoints: string[]
  legacyEndpoints: string[]
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

const PUBLIC_V1_ENDPOINTS = ['/v1', '/v1/health', '/v1/capabilities']
const AUTH_V1_ENDPOINTS = [
  '/v1/projects',
  '/v1/projects/:projectId',
  '/v1/projects/:projectId/runs',
  '/v1/projects/:projectId/messages',
  '/v1/projects/:projectId/runs/:id',
  '/v1/projects/:projectId/runs/:id/messages',
  '/v1/projects/:projectId/runs/:id/stream',
  '/v1/projects/:projectId/runs/:id/cancel',
  '/v1/projects/:projectId/runs/:id/download.zip',
]
const LEGACY_ENDPOINTS: string[] = []

function buildRootResponse(): RootResponse {
  return {
    name: 'etlaq-agent-backend-v2',
    status: 'ok',
    version: API_VERSION,
    docs: ['/docs/api-interface-and-run-cycle.md'],
    endpoints: [...PUBLIC_V1_ENDPOINTS, ...AUTH_V1_ENDPOINTS],
    legacyEndpoints: LEGACY_ENDPOINTS,
  }
}

export const root = api(
  { method: 'GET', path: '/', expose: true },
  async (): Promise<RootResponse> => buildRootResponse(),
)

export const rootV1 = api(
  { method: 'GET', path: '/v1', expose: true },
  async (): Promise<ApiSuccess<RootResponse>> => apiSuccess(buildRootResponse()),
)

export const health = api(
  { method: 'GET', path: '/health', expose: true },
  async (): Promise<HealthResponse> => ({
    status: 'ok',
    ts: new Date().toISOString(),
  }),
)

export const healthV1 = api(
  { method: 'GET', path: '/v1/health', expose: true },
  async (): Promise<ApiSuccess<HealthResponse>> => apiSuccess({
    status: 'ok',
    ts: new Date().toISOString(),
  }),
)

export const capabilities = api(
  { method: 'GET', path: '/capabilities', expose: true },
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

export const capabilitiesV1 = api(
  { method: 'GET', path: '/v1/capabilities', expose: true },
  async (): Promise<ApiSuccess<CapabilitiesResponse>> => apiSuccess({
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
