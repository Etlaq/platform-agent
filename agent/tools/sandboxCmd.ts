import { tool } from 'langchain'
import { z } from 'zod'
import type { Sandbox } from '@e2b/code-interpreter'

const sandboxCmdSchema = z.object({
  cmd: z.string().min(1),
  cwd: z.string().min(1).optional(),
  envs: z.record(z.string().min(1), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

const ALLOWED_BINARIES = new Set(['bun', 'bunx', 'mkdir', 'rm'])
const SHELL_META_PATTERN = /[;&|`$><(){}\n\r]/

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

export function createSandboxCmdTool(params: {
  sandbox: Sandbox
  defaultCwd: string
}) {
  return tool(
    async (input) => {
      const parsed = sandboxCmdSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, error: 'Invalid input.', issues: parsed.error.issues }
      }

      if (!isAllowedCommand(parsed.data.cmd)) {
        return {
          ok: false,
          error:
            'Command denied by policy. Only bun/bunx/mkdir/rm are allowed. ' +
            'Do not use shell operators (cd, &&, |, >, ;). Use the `cwd` option instead. ' +
            'Do not prefix env vars like FOO=bar; use the `envs` option instead.',
        }
      }

      const binary = getBinary(parsed.data.cmd)
      if (binary === 'rm' && targetsGitDir(parsed.data.cmd)) {
        return {
          ok: false,
          error: "Command denied by policy. Do not use rm on the '.git' directory.",
        }
      }

      try {
        const res = await params.sandbox.commands.run(parsed.data.cmd, {
          cwd: parsed.data.cwd ?? params.defaultCwd,
          envs: parsed.data.envs,
          timeoutMs: parsed.data.timeoutMs,
        })

        return {
          ok: true,
          exitCode: (res as any).exitCode ?? 0,
          stdout: (res as any).stdout ?? '',
          stderr: (res as any).stderr ?? '',
        }
      } catch (err) {
        const result = (err as any)?.result
        if (result && typeof result.exitCode === 'number') {
          return {
            ok: false,
            exitCode: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.error ?? (err instanceof Error ? err.message : String(err)),
          }
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
