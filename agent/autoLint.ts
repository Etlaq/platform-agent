export interface SandboxCmdResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

const BUILD_PATTERN = /\bbun\s+run\s+build\b/i

const LINT_PATTERN = /\bbun\s+run\s+lint\b/i

export function extractSandboxCmd(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as { cmd?: unknown }
    if (typeof parsed?.cmd === 'string' && parsed.cmd.trim()) return parsed.cmd
  } catch {
    // ignore parse errors
  }
  return null
}

export function isBuildCommand(cmd: string) {
  return BUILD_PATTERN.test(cmd)
}

export function isLintCommand(cmd: string) {
  return LINT_PATTERN.test(cmd)
}

export function isSuccessfulSandboxResult(out: unknown) {
  const data = (out ?? {}) as Record<string, unknown>
  const ok = data.ok === true
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : (ok ? 0 : 1)
  return ok && exitCode === 0
}

export function toSandboxCmdResult(raw: unknown): SandboxCmdResult {
  const data = (raw ?? {}) as Record<string, unknown>
  const ok = data.ok === true
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : (ok ? 0 : 1)
  return {
    ok,
    exitCode,
    stdout: typeof data.stdout === 'string' ? data.stdout : '',
    stderr: typeof data.stderr === 'string' ? data.stderr : '',
    error: typeof data.error === 'string' ? data.error : undefined,
  }
}

export function resolveAutoLintMaxPasses(raw: string | undefined) {
  const parsed = raw ? Number(raw) : NaN
  if (!Number.isFinite(parsed)) return 2
  return Math.max(0, Math.min(5, Math.trunc(parsed)))
}

export function resolveAutoLintTimeoutMs(raw: string | undefined) {
  const parsed = raw ? Number(raw) : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return 8 * 60_000
  return Math.trunc(parsed)
}

export function shouldAutoLintAfterBuild(params: {
  workspaceMode: 'host' | 'e2b'
  sawBuild: boolean
  enabledRaw?: string
}) {
  if (!params.sawBuild) return false
  if (params.workspaceMode !== 'e2b') return false
  return params.enabledRaw !== 'false'
}

export function truncateForModel(text: string, maxChars: number) {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated]`
}

export function formatLintFailureForModel(params: {
  result: SandboxCmdResult
  cmd: string
  maxChars?: number
}) {
  const sections = [
    `Command: ${params.cmd}`,
    `Exit code: ${params.result.exitCode}`,
    params.result.error ? `Error: ${params.result.error}` : null,
    params.result.stdout ? `stdout:\n${params.result.stdout}` : null,
    params.result.stderr ? `stderr:\n${params.result.stderr}` : null,
  ].filter(Boolean)

  return truncateForModel(sections.join('\n\n'), params.maxChars ?? 12_000)
}
