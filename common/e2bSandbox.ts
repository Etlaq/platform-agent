import { Sandbox } from '@e2b/code-interpreter'
import type { SandboxConnectOpts, SandboxOpts } from '@e2b/code-interpreter'

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function resolveE2BRetryAttempts() {
  // Total attempts including the first attempt.
  return parseBoundedInt(process.env.E2B_RETRY_ATTEMPTS, 3, 1, 20)
}

function resolveE2BRetryBaseDelayMs() {
  return parseBoundedInt(process.env.E2B_RETRY_BASE_DELAY_MS, 750, 0, 60_000)
}

function resolveE2BRetryMaxDelayMs() {
  return parseBoundedInt(process.env.E2B_RETRY_MAX_DELAY_MS, 8_000, 0, 5 * 60_000)
}

function resolveE2BRequestTimeoutMs() {
  // Applies to E2B API calls and long-lived operations initiated via the SDK.
  // E2B SDK defaults to 60s, which can be too aggressive for installs/builds/zips.
  return parseBoundedInt(process.env.E2B_REQUEST_TIMEOUT_MS, 5 * 60_000, 0, 60 * 60_000)
}

function resolveE2BCommandDefaultTimeoutMs() {
  return parseBoundedInt(process.env.E2B_CMD_DEFAULT_TIMEOUT_MS, 5 * 60_000, 1_000, 60 * 60_000)
}

function resolveE2BHardTimeoutGraceMs() {
  return parseBoundedInt(process.env.E2B_HARD_TIMEOUT_GRACE_MS, 15_000, 0, 10 * 60_000)
}

function resolveE2BHardTimeoutMaxMs() {
  return parseBoundedInt(process.env.E2B_HARD_TIMEOUT_MAX_MS, 30 * 60_000, 30_000, 24 * 60 * 60_000)
}

function shouldLogE2BRetries() {
  return (process.env.E2B_RETRY_LOG || 'false').toLowerCase() === 'true'
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function isRetryableE2BError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()

  // Node's fetch (undici) failures.
  if (lower.includes('fetch failed')) return true
  if (lower.includes('connect timeout')) return true
  if (lower.includes('request timed out')) return true
  if (lower.includes('socket hang up')) return true
  if (lower.includes('econnreset')) return true
  if (lower.includes('econnrefused')) return true
  if (lower.includes('etimedout')) return true
  if (lower.includes('enotfound')) return true
  if (lower.includes('eai_again')) return true

  // Transient HTTP-ish failures commonly surfaced as stringified errors.
  if (lower.includes('429') || lower.includes('rate limit')) return true
  if (lower.includes('502') || lower.includes('bad gateway')) return true
  if (lower.includes('503') || lower.includes('service unavailable')) return true
  if (lower.includes('504') || lower.includes('gateway timeout')) return true

  return false
}

function withRequestTimeout<T extends { requestTimeoutMs?: number }>(opts?: T): T | undefined {
  const requestTimeoutMs = resolveE2BRequestTimeoutMs()
  if (!opts) {
    return requestTimeoutMs > 0 ? ({ requestTimeoutMs } as T) : undefined
  }
  if (typeof opts.requestTimeoutMs === 'number') return opts
  return requestTimeoutMs > 0 ? ({ ...opts, requestTimeoutMs } as T) : opts
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  if (attempt <= 0) return 0
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  const jitter = Math.floor(Math.random() * Math.min(250, Math.max(1, exp / 4)))
  return Math.min(maxDelayMs, exp + jitter)
}

async function withE2BRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const attempts = resolveE2BRetryAttempts()
  const baseDelayMs = resolveE2BRetryBaseDelayMs()
  const maxDelayMs = resolveE2BRetryMaxDelayMs()
  const log = shouldLogE2BRetries()

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = isRetryableE2BError(err)
      const finalAttempt = attempt >= attempts
      if (!retryable || finalAttempt) break

      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs)
      if (log) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[e2b] ${label} failed (attempt ${attempt}/${attempts}): ${msg}`)
        if (delayMs > 0) console.warn(`[e2b] retrying in ${delayMs}ms`)
      }
      if (delayMs > 0) {
        await sleep(delayMs)
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function createSandboxWithRetry(template: string, opts?: SandboxOpts): Promise<Sandbox> {
  const merged = withRequestTimeout(opts)
  return await withE2BRetries('Sandbox.create', async () => Sandbox.create(template, merged))
}

export async function connectSandboxWithRetry(sandboxId: string, opts?: SandboxConnectOpts): Promise<Sandbox> {
  const merged = withRequestTimeout(opts)
  return await withE2BRetries('Sandbox.connect', async () => Sandbox.connect(sandboxId, merged))
}

export async function runSandboxCommandWithTimeout(
  sandbox: Sandbox,
  cmd: string,
  opts?: {
    background?: boolean
    cwd?: string
    envs?: Record<string, string>
    timeoutMs?: number
  },
): Promise<unknown> {
  const softTimeoutMs = opts?.timeoutMs ?? resolveE2BCommandDefaultTimeoutMs()
  const hardTimeoutMs = Math.max(
    15_000,
    Math.min(resolveE2BHardTimeoutMaxMs(), softTimeoutMs + resolveE2BHardTimeoutGraceMs()),
  )

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const hardTimeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`sandbox command hard timeout after ${hardTimeoutMs}ms`))
    }, hardTimeoutMs)
  })

  try {
    return await Promise.race([
      sandbox.commands.run(cmd, {
        background: opts?.background ?? false,
        cwd: opts?.cwd,
        envs: opts?.envs,
        timeoutMs: softTimeoutMs,
      } as any),
      hardTimeout,
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
