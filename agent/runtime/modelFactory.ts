import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatGroq } from '@langchain/groq'
import { ChatMistralAI } from '@langchain/mistralai'
import { ChatCohere } from '@langchain/cohere'
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

  function createOpenAICompatible(params: {
    apiKey?: string
    baseURL?: string
    defaultHeaders?: Record<string, string>
  }) {
    return new ChatOpenAI({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      apiKey: params.apiKey,
      configuration: params.baseURL || params.defaultHeaders
        ? {
          ...(params.baseURL ? { baseURL: params.baseURL } : {}),
          ...(params.defaultHeaders ? { defaultHeaders: params.defaultHeaders } : {}),
          fetch: fetchWithUndiciTimeouts,
        }
        : { fetch: fetchWithUndiciTimeouts },
    })
  }

  if (provider === 'openai' || provider === 'xai' || provider === 'openrouter' || provider === 'kimi' || provider === 'qwen') {
    const baseURL = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE

    if (provider === 'openai') {
      return createOpenAICompatible({
        baseURL,
      })
    }

    if (provider === 'xai') {
      const xaiBase = process.env.XAI_BASE_URL || 'https://api.x.ai/v1'
      return createOpenAICompatible({
        apiKey: process.env.XAI_API_KEY,
        baseURL: baseURL || xaiBase,
      })
    }

    if (provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is required when AGENT_PROVIDER=openrouter (or provider=openrouter).')
      }
      const openrouterBase = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
      const referer = process.env.OPENROUTER_SITE_URL || process.env.OPENROUTER_HTTP_REFERER
      const title = process.env.OPENROUTER_APP_NAME || process.env.OPENROUTER_X_TITLE
      return createOpenAICompatible({
        apiKey,
        baseURL: openrouterBase,
        defaultHeaders: {
          ...(referer ? { 'HTTP-Referer': referer } : {}),
          ...(title ? { 'X-Title': title } : {}),
        },
      })
    }

    if (provider === 'kimi') {
      const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY
      if (!apiKey) {
        throw new Error('KIMI_API_KEY or MOONSHOT_API_KEY is required when AGENT_PROVIDER=kimi (or provider=kimi).')
      }
      const kimiBase = (
        process.env.KIMI_BASE_URL ||
        process.env.MOONSHOT_BASE_URL ||
        'https://api.moonshot.ai/v1'
      ).replace(/\/+$/, '')
      return createOpenAICompatible({
        apiKey,
        baseURL: kimiBase,
      })
    }

    const apiKey = process.env.QWEN_API_KEY || process.env.ALIBABA_API_KEY || process.env.DASHSCOPE_API_KEY
    if (!apiKey) {
      throw new Error('QWEN_API_KEY / ALIBABA_API_KEY / DASHSCOPE_API_KEY is required when AGENT_PROVIDER=qwen (or provider=qwen).')
    }
    const qwenBase = (
      process.env.QWEN_BASE_URL ||
      process.env.ALIBABA_BASE_URL ||
      process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    ).replace(/\/+$/, '')
    return createOpenAICompatible({
      apiKey,
      baseURL: qwenBase,
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
      // GLM-5 requires tool_stream for real-time streaming of tool call parameters.
      // Without it tool calls block until the full response is assembled.
      modelKwargs: { tool_stream: true },
    })
  }

  if (provider === 'google') {
    return new ChatGoogleGenerativeAI({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      apiKey: process.env.GOOGLE_API_KEY,
      ...(process.env.GOOGLE_BASE_URL ? { baseUrl: process.env.GOOGLE_BASE_URL } : {}),
    })
  }

  if (provider === 'groq') {
    return new ChatGroq({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      apiKey: process.env.GROQ_API_KEY,
      ...(process.env.GROQ_BASE_URL ? { baseUrl: process.env.GROQ_BASE_URL } : {}),
      fetch: fetchWithUndiciTimeouts,
    })
  }

  if (provider === 'mistral') {
    return new ChatMistralAI({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      apiKey: process.env.MISTRAL_API_KEY,
      ...(process.env.MISTRAL_BASE_URL ? { serverURL: process.env.MISTRAL_BASE_URL } : {}),
    })
  }

  if (provider === 'cohere') {
    return new ChatCohere({
      model: normalizedModel,
      temperature: 0,
      streaming: true,
      streamUsage: true,
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : undefined,
      apiKey: process.env.COHERE_API_KEY,
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
