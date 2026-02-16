import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelProvider } from '../provider'
import { Agent as UndiciAgent } from 'undici'

function parseTimeoutMs(raw: string | undefined) {
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : NaN
}

// Some OpenAI-compatible providers (including Z.AI) can pause streaming for several minutes while
// thinking/processing. Undici (used under the hood by Node's fetch) defaults `bodyTimeout` to 300s,
// which surfaces as a network error with message "terminated" after 5 minutes of inactivity.
//
// We route provider requests through a dispatcher with a higher body timeout to prevent spurious
// retries/cancellations on long-running codegen runs.
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_UNDICI_TIMEOUT_MS = 30 * 60_000
const agentTimeoutMs = parseTimeoutMs(process.env.AGENT_TIMEOUT_MS)
const effectiveAgentTimeoutMs = Number.isFinite(agentTimeoutMs) ? agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS

const undiciBodyTimeoutMs =
  parseTimeoutMs(process.env.UNDICI_BODY_TIMEOUT_MS) ||
  Math.max(effectiveAgentTimeoutMs, DEFAULT_UNDICI_TIMEOUT_MS)
const undiciHeadersTimeoutMs =
  parseTimeoutMs(process.env.UNDICI_HEADERS_TIMEOUT_MS) || undiciBodyTimeoutMs

const undiciDispatcher = new UndiciAgent({
  bodyTimeout: undiciBodyTimeoutMs,
  headersTimeout: undiciHeadersTimeoutMs,
})

const fetchWithUndiciTimeouts: typeof fetch = (input, init) => {
  // `dispatcher` is an undici extension supported by Node's fetch implementation.
  return fetch(input as any, { ...(init ?? {}), dispatcher: undiciDispatcher } as any)
}

export function normalizeModelName(provider: string, model: string) {
  // Convenience aliases for commonly referenced models.
  if (provider === 'zai' && model === 'glm4.7') return 'glm-4.7'
  return model
}

export function createModel(provider: ModelProvider, model: string): BaseChatModel {
  const timeoutMsRaw = process.env.AGENT_TIMEOUT_MS
  // 60s is too aggressive for large codegen + tool planning; use a safer default.
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 10 * 60_000
  const maxRetriesRaw = process.env.AGENT_MAX_RETRIES
  const maxRetries = maxRetriesRaw ? Number(maxRetriesRaw) : 2

  const normalizedModel = normalizeModelName(provider, model)

  if (provider === 'openai' || provider === 'xai') {
    const baseURL = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE
    const xaiBase = process.env.XAI_BASE_URL || 'https://api.x.ai/v1'
    const effectiveBaseURL = provider === 'xai' ? baseURL || xaiBase : baseURL
    const apiKey = provider === 'xai' ? process.env.XAI_API_KEY : undefined
    return new ChatOpenAI({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      apiKey,
      configuration: effectiveBaseURL
        ? { baseURL: effectiveBaseURL, fetch: fetchWithUndiciTimeouts }
        : { fetch: fetchWithUndiciTimeouts },
    })
  }

  if (provider === 'zai') {
    const apiKey = process.env.ZAI_API_KEY
    if (!apiKey) {
      throw new Error('ZAI_API_KEY is required when AGENT_PROVIDER=zai (or provider=zai).')
    }

    const useCoding = process.env.ZAI_USE_CODING_ENDPOINT === 'true'
    const defaultBase = useCoding
      ? 'https://api.z.ai/api/coding/paas/v4'
      : 'https://api.z.ai/api/paas/v4'
    const baseURL = (process.env.ZAI_BASE_URL || defaultBase).replace(/\/+$/, '')

    return new ChatOpenAI({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      apiKey,
      configuration: { baseURL, fetch: fetchWithUndiciTimeouts },
    })
  }

  const anthropicBaseURL = process.env.ANTHROPIC_API_URL || process.env.ANTHROPIC_BASE_URL
  return new ChatAnthropic({
    model: normalizedModel,
    temperature: 0,
    streaming: true,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
    anthropicApiUrl: process.env.ANTHROPIC_API_URL,
    clientOptions: {
      ...(anthropicBaseURL ? { baseURL: anthropicBaseURL } : {}),
      ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}),
      ...(Number.isFinite(maxRetries) ? { maxRetries } : {}),
    },
  })
}
