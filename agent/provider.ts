export type ModelProvider =
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'zai'
  | 'google'
  | 'groq'
  | 'mistral'
  | 'cohere'
  | 'openrouter'
  | 'kimi'
  | 'qwen'

export interface ModelSelection {
  provider: ModelProvider
  model: string
  source: string
}

const DEFAULT_OPENAI_MODEL = 'gpt-5'
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-6'
// xAI is OpenAI-compatible but uses its own model names.
const DEFAULT_XAI_MODEL = 'grok-2-latest'
// Z.AI is OpenAI-compatible (base URL differs from OpenAI).
const DEFAULT_ZAI_MODEL = 'glm-4.7'
const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-pro'
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'
const DEFAULT_MISTRAL_MODEL = 'mistral-large-latest'
const DEFAULT_COHERE_MODEL = 'command-r-plus'
// OpenRouter aggregates provider-prefixed model ids.
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini'
// Kimi/Moonshot OpenAI-compatible endpoint.
const DEFAULT_KIMI_MODEL = 'moonshot-v1-8k'
// Qwen via Alibaba DashScope OpenAI-compatible endpoint.
const DEFAULT_QWEN_MODEL = 'qwen-max'

function normalizeProvider(value: string | undefined): ModelProvider | null {
  if (!value) return null
  const lowered = value.toLowerCase()
  if (lowered === 'openai') return 'openai'
  if (lowered === 'anthropic') return 'anthropic'
  if (lowered === 'xai') return 'xai'
  if (lowered === 'zai') return 'zai'
  if (lowered === 'google' || lowered === 'gemini') return 'google'
  if (lowered === 'groq') return 'groq'
  if (lowered === 'mistral') return 'mistral'
  if (lowered === 'cohere') return 'cohere'
  if (lowered === 'openrouter') return 'openrouter'
  if (lowered === 'kimi' || lowered === 'moonshot') return 'kimi'
  if (lowered === 'qwen' || lowered === 'alibaba' || lowered === 'dashscope') return 'qwen'
  return null
}

function hasNonEmpty(value: string | undefined) {
  return Boolean(value && value.trim().length > 0)
}

function resolveProviderByAvailableKeys(env: Record<string, string | undefined>): ModelProvider | null {
  if (hasNonEmpty(env.OPENAI_API_KEY)) return 'openai'
  if (hasNonEmpty(env.XAI_API_KEY)) return 'xai'
  if (hasNonEmpty(env.ZAI_API_KEY)) return 'zai'
  if (hasNonEmpty(env.GOOGLE_API_KEY)) return 'google'
  if (hasNonEmpty(env.GROQ_API_KEY)) return 'groq'
  if (hasNonEmpty(env.MISTRAL_API_KEY)) return 'mistral'
  if (hasNonEmpty(env.COHERE_API_KEY)) return 'cohere'
  if (hasNonEmpty(env.OPENROUTER_API_KEY)) return 'openrouter'
  if (hasNonEmpty(env.KIMI_API_KEY) || hasNonEmpty(env.MOONSHOT_API_KEY)) return 'kimi'
  if (hasNonEmpty(env.QWEN_API_KEY) || hasNonEmpty(env.ALIBABA_API_KEY) || hasNonEmpty(env.DASHSCOPE_API_KEY)) {
    return 'qwen'
  }
  if (hasNonEmpty(env.ANTHROPIC_API_KEY)) return 'anthropic'
  return null
}

export function resolveModelSelection(overrides?: {
  provider?: string
  model?: string
}, opts?: { env?: Record<string, string | undefined> }): ModelSelection {
  const env = opts?.env ?? (process.env as Record<string, string | undefined>)
  const providerOverride = normalizeProvider(overrides?.provider)
  const envProvider = normalizeProvider(env.AGENT_PROVIDER)

  const provider =
    providerOverride ||
    envProvider ||
    resolveProviderByAvailableKeys(env)

  if (!provider) {
    throw new Error(
      'No model provider configured. Set one of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY / COHERE_API_KEY / XAI_API_KEY / ZAI_API_KEY / OPENROUTER_API_KEY / KIMI_API_KEY / MOONSHOT_API_KEY / QWEN_API_KEY / ALIBABA_API_KEY / DASHSCOPE_API_KEY, or pass provider in the request.'
    )
  }

  const modelOverride = overrides?.model
  const modelFromGenericEnv = env.AGENT_MODEL
  const modelFromEnv =
    provider === 'openai'
      ? env.OPENAI_MODEL
      : provider === 'xai'
        ? env.XAI_MODEL
        : provider === 'zai'
          ? env.ZAI_MODEL
          : provider === 'google'
            ? env.GOOGLE_MODEL ?? env.GEMINI_MODEL
            : provider === 'groq'
              ? env.GROQ_MODEL
              : provider === 'mistral'
                ? env.MISTRAL_MODEL
                : provider === 'cohere'
                  ? env.COHERE_MODEL
          : provider === 'openrouter'
            ? env.OPENROUTER_MODEL
            : provider === 'kimi'
              ? env.KIMI_MODEL ?? env.MOONSHOT_MODEL
              : provider === 'qwen'
                ? env.QWEN_MODEL ?? env.ALIBABA_MODEL ?? env.DASHSCOPE_MODEL
        : env.ANTHROPIC_MODEL

  const model =
    modelOverride ||
    modelFromEnv ||
    modelFromGenericEnv ||
    (provider === 'openai'
      ? DEFAULT_OPENAI_MODEL
      : provider === 'xai'
        ? DEFAULT_XAI_MODEL
        : provider === 'zai'
          ? DEFAULT_ZAI_MODEL
          : provider === 'google'
            ? DEFAULT_GOOGLE_MODEL
            : provider === 'groq'
              ? DEFAULT_GROQ_MODEL
              : provider === 'mistral'
                ? DEFAULT_MISTRAL_MODEL
                : provider === 'cohere'
                  ? DEFAULT_COHERE_MODEL
          : provider === 'openrouter'
            ? DEFAULT_OPENROUTER_MODEL
            : provider === 'kimi'
              ? DEFAULT_KIMI_MODEL
              : provider === 'qwen'
                ? DEFAULT_QWEN_MODEL
        : DEFAULT_ANTHROPIC_MODEL)

  const source = modelOverride
    ? 'request'
    : modelFromEnv || modelFromGenericEnv
      ? 'env'
      : 'default'

  return { provider, model, source }
}
