import { tool } from 'langchain'
import { z } from 'zod'
import type { Sandbox } from '@e2b/code-interpreter'
import { runSandboxCommandWithTimeout } from '../../common/e2bSandbox'
import { isBuildCommand } from '../autoLint'

const sandboxCmdSchema = z.object({
  cmd: z.string().min(1),
  cwd: z.string().min(1).optional(),
  envs: z.record(z.string().min(1), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

const ALLOWED_BINARIES = new Set(['bun', 'bunx', 'mkdir', 'rm'])
const SHELL_META_PATTERN = /[;&|`$><(){}\n\r]/
const LEGACY_APP_ROOT = '/app'

function getBinary(cmd: string) {
  const trimmed = cmd.trim()
  if (!trimmed) return null
  const [binary] = trimmed.split(/\s+/, 1)
  return binary || null
}

function targetsGitDir(cmd: string): boolean {
  // Block attempts to delete the repository metadata directory.
  // Keep this conservative: deny `.git` as a path segment or glob prefix, but allow `.gitignore`, `.github`, etc.
  const raw = cmd.trim()
  if (!raw) return false

  const lower = raw.toLowerCase()
  const isWord = (ch: string) => (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_'
  const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
  const isBoundaryBefore = (ch: string) => isSpace(ch) || ch === '"' || ch === "'" || ch === '/'
  const isBoundaryAfter = (ch: string) => isSpace(ch) || ch === '"' || ch === "'" || ch === '/' || !isWord(ch)

  let idx = 0
  while (idx < lower.length) {
    const at = lower.indexOf('.git', idx)
    if (at === -1) break

    const before = at === 0 ? '' : lower[at - 1]!
    const afterPos = at + 4
    const after = afterPos >= lower.length ? '' : lower[afterPos]!

    const okBefore = at === 0 || isBoundaryBefore(before)
    const okAfter = afterPos >= lower.length || isBoundaryAfter(after)

    if (okBefore && okAfter) return true
    idx = at + 4
  }

  return false
}

function isAllowedCommand(cmd: string) {
  const trimmed = cmd.trim()
  if (!trimmed) return false
  if (SHELL_META_PATTERN.test(trimmed)) return false
  const binary = getBinary(trimmed)
  if (!binary) return false
  return ALLOWED_BINARIES.has(binary)
}

function normalizePathToken(token: string, workspaceRoot: string) {
  if (!token.startsWith('/')) return token
  if (token === workspaceRoot || token.startsWith(`${workspaceRoot}/`)) return token
  if (token === LEGACY_APP_ROOT) return workspaceRoot
  if (token.startsWith(`${LEGACY_APP_ROOT}/`)) {
    return `${workspaceRoot}${token.slice(LEGACY_APP_ROOT.length)}`
  }
  if (token === '/') return workspaceRoot
  // In DeepAgents virtual FS, absolute paths are rooted at project "/".
  // Map them into the sandbox workspace root so sandbox_cmd stays consistent.
  return `${workspaceRoot}${token}`
}

function normalizeLegacyAppPath(value: string, defaultCwd: string) {
  if (!value) return value
  const fallback = defaultCwd.trim().replace(/\/+$/, '')
  if (!fallback) return value

  return value
    .trim()
    .split(/\s+/)
    .map((token) => normalizePathToken(token, fallback))
    .join(' ')
}

function normalizeCwd(cwd: string, defaultCwd: string) {
  const normalized = normalizeLegacyAppPath(cwd, defaultCwd)
  return normalized || defaultCwd
}

function isTimeoutError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return lower.includes('deadline_exceeded') || lower.includes('timed out') || lower.includes('timeout')
}

async function cleanupStaleNextBuild(params: { sandbox: Sandbox; cwd: string }) {
  // E2B command timeouts can leave orphaned build processes behind.
  // Kill stale Next.js build processes before/after build attempts.
  // Use bracketed regex chars to avoid matching this cleanup shell itself.
  const cleanupCmd =
    "pkill -f 'node .*/node_modules/.bin/[n]ext build' || true; " +
    "pkill -f 'node .*/\\.next/build/[p]ostcss\\.js' || true; " +
    "pkill -f 'node .*/\\.next/dev/build/[p]ostcss\\.js' || true; " +
    "pkill -f '(^| )b[u]n run build( |$)' || true; " +
    "rm -f .next/lock || true"
  await runSandboxCommandWithTimeout(params.sandbox, cleanupCmd, {
    cwd: params.cwd,
    timeoutMs: 10_000,
  }).catch(() => undefined)
}

export function createSandboxCmdTool(params: {
  sandbox: Sandbox
  defaultCwd: string
  onStdout?: (event: { cmd: string; cwd: string; chunk: string }) => void | Promise<void>
  onStderr?: (event: { cmd: string; cwd: string; chunk: string }) => void | Promise<void>
}) {
  return tool(
    async (input) => {
      const parsed = sandboxCmdSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, error: 'Invalid input.', issues: parsed.error.issues }
      }

      const normalizedCmd = normalizeLegacyAppPath(parsed.data.cmd, params.defaultCwd)
      if (!isAllowedCommand(normalizedCmd)) {
        return {
          ok: false,
          error:
            'Command denied by policy. Only bun/bunx/mkdir/rm are allowed. ' +
            'Do not use shell operators (cd, &&, |, >, ;). Use the `cwd` option instead. ' +
            'Do not prefix env vars like FOO=bar; use the `envs` option instead.',
        }
      }

      const binary = getBinary(normalizedCmd)
      if (binary === 'rm' && targetsGitDir(normalizedCmd)) {
        return {
          ok: false,
          error: "Command denied by policy. Do not use rm on the '.git' directory.",
        }
      }

      const cwd = normalizeCwd(parsed.data.cwd ?? params.defaultCwd, params.defaultCwd)
      const buildCmd = isBuildCommand(normalizedCmd)
      if (buildCmd) {
        await cleanupStaleNextBuild({ sandbox: params.sandbox, cwd })
      }

      try {
        const res = await runSandboxCommandWithTimeout(params.sandbox, normalizedCmd, {
          cwd,
          envs: parsed.data.envs,
          timeoutMs: parsed.data.timeoutMs,
          onStdout: (data) => params.onStdout?.({ cmd: normalizedCmd, cwd, chunk: data }),
          onStderr: (data) => params.onStderr?.({ cmd: normalizedCmd, cwd, chunk: data }),
        })

        return {
          ok: true,
          executedCmd: normalizedCmd,
          exitCode: (res as any).exitCode ?? 0,
          stdout: (res as any).stdout ?? '',
          stderr: (res as any).stderr ?? '',
        }
      } catch (err) {
        if (buildCmd && isTimeoutError(err)) {
          await cleanupStaleNextBuild({ sandbox: params.sandbox, cwd })
        }
        const result = (err as any)?.result
        if (result && typeof result.exitCode === 'number') {
          return {
            ok: false,
            executedCmd: normalizedCmd,
            exitCode: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.error ?? (err instanceof Error ? err.message : String(err)),
          }
        }
        return { ok: false, executedCmd: normalizedCmd, error: err instanceof Error ? err.message : String(err) }
      }
    },
    {
      name: 'sandbox_cmd',
      description:
        'Run a limited set of commands inside the E2B sandbox (bun/bunx/mkdir/rm). Supports `cwd` and `envs`.',
      schema: sandboxCmdSchema as any,
    }
  )
}
