import { api, APIError, ErrCode } from 'encore.dev/api'
import { secret } from 'encore.dev/config'
import { Sandbox } from '@e2b/code-interpreter'
import { assertE2BConfigured, isReachable, parsePositiveInt, resolveE2BTemplate, resolveSandboxAppDir } from '../common/e2b'
import { connectSandboxWithRetry, createSandboxWithRetry, runSandboxCommandWithTimeout } from '../common/e2bSandbox'

import '../auth/auth'

interface ExecRequest {
  sandboxId?: string
  cmd: string
  cwd?: string
  envs?: Record<string, string>
  background?: boolean
  timeoutMs?: number
}

interface SandboxCreateRequest {
  template?: string
  timeoutMs?: number
}

interface SandboxInfoRequest {
  sandboxId: string
}

interface SandboxStartRequest {
  sandboxId?: string
  template?: string
  port?: number
}

interface SandboxStopRequest {
  sandboxId: string
  pid: number
  killSandbox?: boolean
}

interface ExecResponse {
  ok: boolean
  sandboxId: string | null
  nextjsUrl: string
  stdout?: string | null
  stderr?: string | null
  exitCode?: number | null
  error?: string
  pid?: number | null
}

interface SandboxPortInfo {
  port: number
  host: string
  url: string
}

interface SandboxCreateResponse {
  ok: true
  sandboxId: string | null
  domain: string | null
  ports: {
    nextjs: SandboxPortInfo
  }
}

interface SandboxInfoResponse {
  ok: true
  sandboxId: string
  running: boolean
  commands: unknown[]
  ports: {
    nextjs: SandboxPortInfo
  }
}

interface SandboxStartResponse {
  ok: true
  reused: boolean
  sandboxId: string | null
  pid?: number | null
  port: number
  host: string
  url: string
}

interface SandboxStopResponse {
  ok: true
  killed: boolean
  killSandbox: boolean
}

const e2bApiKeySecrets = [secret('E2B_API_KEY'), secret('E2BApiKey')]
const e2bTemplateSecrets = [secret('E2B_TEMPLATE'), secret('E2BTemplate')]

function normalizeSecret(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function hydrateSandboxEnvFromSecrets() {
  const currentApiKey = normalizeSecret(process.env.E2B_API_KEY)
  if (!currentApiKey) {
    for (const readSecret of e2bApiKeySecrets) {
      try {
        const apiKey = normalizeSecret(readSecret())
        if (apiKey) {
          process.env.E2B_API_KEY = apiKey
          break
        }
      } catch {
        // Validation below returns the user-facing error.
      }
    }
  }

  const currentTemplate = normalizeSecret(process.env.E2B_TEMPLATE)
  if (!currentTemplate) {
    for (const readSecret of e2bTemplateSecrets) {
      try {
        const template = normalizeSecret(readSecret())
        if (template) {
          process.env.E2B_TEMPLATE = template
          break
        }
      } catch {
        // Validation below returns the user-facing error.
      }
    }
  }
}

function ensureE2BConfigured() {
  hydrateSandboxEnvFromSecrets()
  assertE2BConfigured()
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const exec = api(
  { method: 'POST', path: '/exec', expose: true, auth: true },
  async (payload: ExecRequest): Promise<ExecResponse> => {
    ensureE2BConfigured()

    if (!payload.cmd || payload.cmd.trim().length === 0) {
      throw APIError.invalidArgument('cmd is required')
    }

    const template = resolveE2BTemplate()
    const defaultCwd = resolveSandboxAppDir() || '/home/user'

    const sb = payload.sandboxId
      ? await connectSandboxWithRetry(payload.sandboxId)
      : await createSandboxWithRetry(template)

    const sandboxId = (sb as any).sandboxId ?? payload.sandboxId ?? null
    const nextUrl = `https://${sb.getHost(3000)}`

    try {
      const cmdRes = await runSandboxCommandWithTimeout(sb, payload.cmd, {
        background: payload.background ?? false,
        cwd: payload.cwd ?? defaultCwd,
        envs: payload.envs,
        timeoutMs: payload.timeoutMs,
      })

      if (payload.background) {
        const handle = cmdRes as any
        return {
          ok: true,
          sandboxId,
          pid: handle?.pid ?? null,
          nextjsUrl: nextUrl,
        }
      }

      const result = cmdRes as any
      return {
        ok: true,
        sandboxId,
        nextjsUrl: nextUrl,
        stdout: result?.stdout ?? null,
        stderr: result?.stderr ?? null,
        exitCode: result?.exitCode ?? null,
      }
    } catch (error) {
      const result = (error as any)?.result
      if (result && typeof result.exitCode === 'number') {
        return {
          ok: false,
          sandboxId,
          nextjsUrl: nextUrl,
          exitCode: result.exitCode ?? null,
          stdout: result.stdout ?? null,
          stderr: result.stderr ?? null,
          error: result.error ?? (error instanceof Error ? error.message : String(error)),
        }
      }

      throw new APIError(ErrCode.Internal, error instanceof Error ? error.message : String(error))
    }
  },
)

export const sandboxCreate = api(
  { method: 'POST', path: '/sandbox/create', expose: true, auth: true },
  async (payload: SandboxCreateRequest): Promise<SandboxCreateResponse> => {
    ensureE2BConfigured()

    const template = resolveE2BTemplate(payload.template)
    const timeoutMs = payload.timeoutMs && payload.timeoutMs > 0 ? payload.timeoutMs : undefined

    const sb = await createSandboxWithRetry(
      template,
      timeoutMs ? { timeoutMs } : undefined,
    )

    return {
      ok: true,
      sandboxId: (sb as any).sandboxId ?? null,
      domain: (sb as any).sandboxDomain ?? null,
      ports: {
        nextjs: {
          port: 3000,
          host: sb.getHost(3000),
          url: `https://${sb.getHost(3000)}`,
        },
      },
    }
  },
)

export const sandboxInfo = api(
  { method: 'POST', path: '/sandbox/info', expose: true, auth: true },
  async ({ sandboxId }: SandboxInfoRequest): Promise<SandboxInfoResponse> => {
    ensureE2BConfigured()

    const sb = await connectSandboxWithRetry(sandboxId)
    const running = await sb.isRunning().catch(() => false)
    const commands = await sb.commands.list().catch(() => [])

    return {
      ok: true,
      sandboxId,
      running,
      commands,
      ports: {
        nextjs: {
          port: 3000,
          host: sb.getHost(3000),
          url: `https://${sb.getHost(3000)}`,
        },
      },
    }
  },
)

export const sandboxDevStart = api(
  { method: 'POST', path: '/sandbox/dev/start', expose: true, auth: true },
  async (payload: SandboxStartRequest): Promise<SandboxStartResponse> => {
    ensureE2BConfigured()

    const port = parsePositiveInt(payload.port, 3000)
    const template = resolveE2BTemplate(payload.template)
    const appDir = resolveSandboxAppDir()

    const sb = payload.sandboxId
      ? await connectSandboxWithRetry(payload.sandboxId)
      : await createSandboxWithRetry(template)

    const url = `https://${sb.getHost(port)}`
    if (await isReachable(url, 2500)) {
      return {
        ok: true,
        reused: true,
        sandboxId: (sb as any).sandboxId ?? payload.sandboxId ?? null,
        port,
        host: sb.getHost(port),
        url,
      }
    }

    const cmd = `cd ${shellQuote(appDir)} && PORT=${port} HOST=0.0.0.0 bun run dev -- --hostname 0.0.0.0 --port ${port}`
    const handle = (await runSandboxCommandWithTimeout(sb, cmd, { background: true })) as any

    return {
      ok: true,
      reused: false,
      sandboxId: (sb as any).sandboxId ?? payload.sandboxId ?? null,
      pid: handle?.pid ?? null,
      port,
      host: sb.getHost(port),
      url,
    }
  },
)

export const sandboxDevStop = api(
  { method: 'POST', path: '/sandbox/dev/stop', expose: true, auth: true },
  async (payload: SandboxStopRequest): Promise<SandboxStopResponse> => {
    ensureE2BConfigured()

    const sb = await connectSandboxWithRetry(payload.sandboxId)
    const killed = await sb.commands.kill(payload.pid).catch(() => false)

    if (payload.killSandbox) {
      await sb.kill().catch(() => undefined)
    }

    return {
      ok: true,
      killed,
      killSandbox: payload.killSandbox ?? false,
    }
  },
)
