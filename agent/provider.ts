export type ModelProvider = 'openai' | 'anthropic' | 'xai' | 'zai'

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

function normalizeProvider(value: string | undefined): ModelProvider | null {
  if (!value) return null
  const lowered = value.toLowerCase()
  if (lowered === 'openai') return 'openai'
  if (lowered === 'anthropic') return 'anthropic'
  if (lowered === 'xai') return 'xai'
  if (lowered === 'zai') return 'zai'
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
    (env.OPENAI_API_KEY
      ? 'openai'
      : env.XAI_API_KEY
        ? 'xai'
        : env.ZAI_API_KEY
          ? 'zai'
      : env.ANTHROPIC_API_KEY
        ? 'anthropic'
        : null)

  if (!provider) {
    throw new Error(
      'No model provider configured. Set OPENAI_API_KEY / XAI_API_KEY / ZAI_API_KEY / ANTHROPIC_API_KEY, or pass provider in the request.'
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
        : DEFAULT_ANTHROPIC_MODEL)

  const source = modelOverride
    ? 'request'
    : modelFromEnv || modelFromGenericEnv
      ? 'env'
      : 'default'

  return { provider, model, source }
}
