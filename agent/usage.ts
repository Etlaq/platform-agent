export interface AccumulatedUsage {
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  cachedInputTokens: number
  reasoningOutputTokens: number
}

export function accumulateUsage(messages: unknown[]): AccumulatedUsage {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let cachedInputTokens = 0
  let reasoningOutputTokens = 0

  for (const m of messages as any[]) {
    const u = (m as any)?.usage_metadata ?? (m as any)?.usageMetadata
    if (!u) continue
    const i = Number(u.input_tokens ?? u.inputTokens ?? 0)
    const o = Number(u.output_tokens ?? u.outputTokens ?? 0)
    const t = Number(u.total_tokens ?? u.totalTokens ?? 0)
    const inputDetails = (u.input_token_details ?? u.inputTokenDetails) as any
    const outputDetails = (u.output_token_details ?? u.outputTokenDetails) as any
    const cached = Number(inputDetails?.cache_read ?? inputDetails?.cacheRead ?? 0)
    const reasoning = Number(outputDetails?.reasoning ?? 0)
    if (Number.isFinite(i)) inputTokens += i
    if (Number.isFinite(o)) outputTokens += o
    if (Number.isFinite(t)) totalTokens += t
    if (Number.isFinite(cached)) cachedInputTokens += cached
    if (Number.isFinite(reasoning)) reasoningOutputTokens += reasoning
  }

  if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
    totalTokens = inputTokens + outputTokens
  }

  return {
    usage: { inputTokens, outputTokens, totalTokens },
    cachedInputTokens,
    reasoningOutputTokens,
  }
}
