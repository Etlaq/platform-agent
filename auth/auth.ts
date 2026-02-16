import { APIError, Header, Gateway } from 'encore.dev/api'
import { authHandler } from 'encore.dev/auth'
import { secret } from 'encore.dev/config'

const agentApiKeySecret = secret('AgentApiKey')

function normalizeOptionalSecret(secretValue: string | null | undefined) {
  if (typeof secretValue !== 'string') return null
  const trimmed = secretValue.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolveAgentApiKey() {
  const fromEnv = normalizeOptionalSecret(process.env.AGENT_API_KEY)
  if (fromEnv) return fromEnv

  try {
    const fromSecret = normalizeOptionalSecret(agentApiKeySecret())
    if (fromSecret) return fromSecret
  } catch {
    // Ignore secret lookup errors and return a clear API error below.
  }

  throw APIError.invalidArgument('AGENT_API_KEY must be set to use control-plane endpoints.')
}

interface AgentAuthParams {
  apiKey?: Header<'X-Agent-Api-Key'>
  authorization?: Header<'Authorization'>
}

interface AgentAuthData {
  userID: string
  scope: 'control-plane'
}

function parseBearerToken(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = /^Bearer\s+(.+)$/i.exec(trimmed)
  return match?.[1]?.trim() || null
}

export const agentAuth = authHandler<AgentAuthParams, AgentAuthData>(
  async ({ apiKey, authorization }) => {
    const expected = resolveAgentApiKey()
    const bearer = parseBearerToken(authorization)
    const token = normalizeOptionalSecret(apiKey) ?? bearer
    if (token !== expected) {
      throw APIError.unauthenticated('unauthorized')
    }
    return { userID: 'control-plane', scope: 'control-plane' }
  }
)

export const gateway = new Gateway({ authHandler: agentAuth })
