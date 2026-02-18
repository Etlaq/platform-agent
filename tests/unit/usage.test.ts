import { describe, expect, it } from 'bun:test'

import { accumulateUsage } from '../../agent/usage'

describe('accumulateUsage', () => {
  it('returns zeros for empty array', () => {
    const result = accumulateUsage([])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(result.cachedInputTokens).toBe(0)
    expect(result.reasoningOutputTokens).toBe(0)
  })

  it('accumulates snake_case usage_metadata', () => {
    const messages = [
      { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      { usage_metadata: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
    ]
    const result = accumulateUsage(messages)
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 })
  })

  it('accumulates camelCase usageMetadata', () => {
    const messages = [
      { usageMetadata: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } },
    ]
    const result = accumulateUsage(messages)
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 })
  })

  it('computes totalTokens fallback when zero', () => {
    const messages = [
      { usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 0 } },
    ]
    const result = accumulateUsage(messages)
    expect(result.usage.totalTokens).toBe(150)
  })

  it('extracts cached input tokens from input_token_details', () => {
    const messages = [
      {
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_token_details: { cache_read: 40 },
        },
      },
    ]
    const result = accumulateUsage(messages)
    expect(result.cachedInputTokens).toBe(40)
  })

  it('extracts cached input tokens from camelCase inputTokenDetails', () => {
    const messages = [
      {
        usageMetadata: {
          inputTokens: 80,
          outputTokens: 30,
          totalTokens: 110,
          inputTokenDetails: { cacheRead: 25 },
        },
      },
    ]
    const result = accumulateUsage(messages)
    expect(result.cachedInputTokens).toBe(25)
  })

  it('extracts reasoning output tokens', () => {
    const messages = [
      {
        usage_metadata: {
          input_tokens: 50,
          output_tokens: 200,
          total_tokens: 250,
          output_token_details: { reasoning: 120 },
        },
      },
    ]
    const result = accumulateUsage(messages)
    expect(result.reasoningOutputTokens).toBe(120)
  })

  it('skips messages without usage metadata', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { usage_metadata: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
      { role: 'assistant', content: 'hi' },
    ]
    const result = accumulateUsage(messages)
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3, totalTokens: 8 })
  })

  it('handles mixed snake_case and camelCase across messages', () => {
    const messages = [
      { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      { usageMetadata: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
    ]
    const result = accumulateUsage(messages)
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 })
  })

  it('ignores non-finite values', () => {
    const messages = [
      { usage_metadata: { input_tokens: NaN, output_tokens: Infinity, total_tokens: 10 } },
    ]
    const result = accumulateUsage(messages)
    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
    expect(result.usage.totalTokens).toBe(10)
  })
})
