import { describe, expect, it } from 'bun:test'

let moduleSeq = 0

async function loadProviderModule() {
  moduleSeq += 1
  return import(`../../agent/provider?provider-selection-${moduleSeq}`)
}

describe('provider selection', () => {
  it('supports openrouter via provider alias and env model', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'openrouter' },
      {
        env: {
          OPENROUTER_MODEL: 'anthropic/claude-3.7-sonnet',
        },
      },
    )

    expect(resolved.provider).toBe('openrouter')
    expect(resolved.model).toBe('anthropic/claude-3.7-sonnet')
    expect(resolved.source).toBe('env')
  })

  it('supports kimi aliases', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'moonshot' },
      {
        env: {
          MOONSHOT_MODEL: 'kimi-k2-turbo-preview',
        },
      },
    )

    expect(resolved.provider).toBe('kimi')
    expect(resolved.model).toBe('kimi-k2-turbo-preview')
  })

  it('supports qwen/alibaba aliases', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'alibaba' },
      {
        env: {
          ALIBABA_MODEL: 'qwen-max',
        },
      },
    )

    expect(resolved.provider).toBe('qwen')
    expect(resolved.model).toBe('qwen-max')
  })

  it('resolves gemini alias to google', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'gemini' },
      { env: {} },
    )

    expect(resolved.provider).toBe('google')
    expect(resolved.source).toBe('default')
  })

  it('uses default model when no env or request model set', async () => {
    const { resolveModelSelection } = await loadProviderModule()

    expect(resolveModelSelection({ provider: 'openai' }, { env: {} }).model).toBe('gpt-5')
    expect(resolveModelSelection({ provider: 'anthropic' }, { env: {} }).model).toBe('claude-opus-4-6')
    expect(resolveModelSelection({ provider: 'google' }, { env: {} }).model).toBe('gemini-2.5-pro')
    expect(resolveModelSelection({ provider: 'groq' }, { env: {} }).model).toBe('llama-3.3-70b-versatile')
    expect(resolveModelSelection({ provider: 'xai' }, { env: {} }).model).toBe('grok-2-latest')
    expect(resolveModelSelection({ provider: 'zai' }, { env: {} }).model).toBe('glm-4.7')
  })

  it('request model override takes priority over env', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'openai', model: 'o3-mini' },
      { env: { OPENAI_MODEL: 'gpt-4o' } },
    )

    expect(resolved.model).toBe('o3-mini')
    expect(resolved.source).toBe('request')
  })

  it('env model takes priority over default', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'openai' },
      { env: { OPENAI_MODEL: 'gpt-4o' } },
    )

    expect(resolved.model).toBe('gpt-4o')
    expect(resolved.source).toBe('env')
  })

  it('AGENT_MODEL generic env works as fallback', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'openai' },
      { env: { AGENT_MODEL: 'custom-model' } },
    )

    expect(resolved.model).toBe('custom-model')
    expect(resolved.source).toBe('env')
  })

  it('auto-detects provider from API key env vars', async () => {
    const { resolveModelSelection } = await loadProviderModule()

    expect(resolveModelSelection({}, { env: { OPENAI_API_KEY: 'sk-test' } }).provider).toBe('openai')
    expect(resolveModelSelection({}, { env: { GOOGLE_API_KEY: 'gkey' } }).provider).toBe('google')
    expect(resolveModelSelection({}, { env: { GROQ_API_KEY: 'gqkey' } }).provider).toBe('groq')
    expect(resolveModelSelection({}, { env: { XAI_API_KEY: 'xkey' } }).provider).toBe('xai')
    expect(resolveModelSelection({}, { env: { MOONSHOT_API_KEY: 'mkey' } }).provider).toBe('kimi')
    expect(resolveModelSelection({}, { env: { DASHSCOPE_API_KEY: 'dkey' } }).provider).toBe('qwen')
  })

  it('AGENT_PROVIDER env takes priority over key auto-detection', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      {},
      { env: { AGENT_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-test' } },
    )

    expect(resolved.provider).toBe('anthropic')
  })

  it('request provider takes priority over AGENT_PROVIDER env', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    const resolved = resolveModelSelection(
      { provider: 'google' },
      { env: { AGENT_PROVIDER: 'openai' } },
    )

    expect(resolved.provider).toBe('google')
  })

  it('throws when no provider is configured', async () => {
    const { resolveModelSelection } = await loadProviderModule()
    expect(() => resolveModelSelection({}, { env: {} })).toThrow('No model provider configured')
  })
})
