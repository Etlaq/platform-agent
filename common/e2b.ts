import { APIError, ErrCode } from 'encore.dev/api'
import { hydrateRuntimeEnvFromSecrets } from './runtimeSecrets'

export function parsePositiveInt(value: number | undefined, fallback: number, min = 1) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.trunc(value!))
}

export function resolveE2BTemplate(override?: string) {
  hydrateRuntimeEnvFromSecrets()
  return override || process.env.E2B_TEMPLATE || 'code-interpreter-v1'
}

export function resolveSandboxAppDir() {
  return process.env.SANDBOX_APP_DIR || '/home/user'
}

export function assertE2BConfigured() {
  hydrateRuntimeEnvFromSecrets()

  if (!process.env.E2B_API_KEY) {
    throw new APIError(ErrCode.Unavailable, 'E2B not configured (E2B_API_KEY missing).')
  }

  const template = process.env.E2B_TEMPLATE
  if (!template || template.trim().length === 0) {
    throw APIError.invalidArgument('E2B_TEMPLATE must be set (use your built Next.js template).')
  }
}

export async function isReachable(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    return res.ok || (res.status >= 200 && res.status < 500)
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
