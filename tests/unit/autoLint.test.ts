import { describe, expect, it } from 'bun:test'

import {
  extractSandboxCmd,
  formatLintFailureForModel,
  isBuildCommand,
  isLintCommand,
  isSuccessfulSandboxResult,
  resolveAutoLintMaxPasses,
  resolveAutoLintTimeoutMs,
  shouldAutoLintAfterBuild,
  toSandboxCmdResult,
  truncateForModel,
} from '../../agent/autoLint'

describe('isBuildCommand', () => {
  it('matches "bun run build"', () => {
    expect(isBuildCommand('bun run build')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isBuildCommand('BUN RUN BUILD')).toBe(true)
  })

  it('rejects npm/pnpm/npx build commands', () => {
    expect(isBuildCommand('npm run build')).toBe(false)
    expect(isBuildCommand('pnpm run build')).toBe(false)
    expect(isBuildCommand('npx next build')).toBe(false)
  })

  it('rejects unrelated commands', () => {
    expect(isBuildCommand('bun run test')).toBe(false)
    expect(isBuildCommand('bun install')).toBe(false)
    expect(isBuildCommand('cat build.log')).toBe(false)
  })
})

describe('isLintCommand', () => {
  it('matches "bun run lint"', () => {
    expect(isLintCommand('bun run lint')).toBe(true)
  })

  it('rejects non-bun lint', () => {
    expect(isLintCommand('npm run lint')).toBe(false)
    expect(isLintCommand('eslint .')).toBe(false)
  })
})

describe('extractSandboxCmd', () => {
  it('extracts cmd from valid JSON', () => {
    expect(extractSandboxCmd('{"cmd":"ls -la"}')).toBe('ls -la')
  })

  it('returns null for missing cmd', () => {
    expect(extractSandboxCmd('{"action":"list"}')).toBeNull()
  })

  it('returns null for empty cmd', () => {
    expect(extractSandboxCmd('{"cmd":"  "}')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(extractSandboxCmd('not json')).toBeNull()
  })
})

describe('isSuccessfulSandboxResult', () => {
  it('returns true for ok=true, exitCode=0', () => {
    expect(isSuccessfulSandboxResult({ ok: true, exitCode: 0 })).toBe(true)
  })

  it('returns false for ok=false', () => {
    expect(isSuccessfulSandboxResult({ ok: false, exitCode: 0 })).toBe(false)
  })

  it('returns false for non-zero exit code', () => {
    expect(isSuccessfulSandboxResult({ ok: true, exitCode: 1 })).toBe(false)
  })

  it('handles null/undefined gracefully', () => {
    expect(isSuccessfulSandboxResult(null)).toBe(false)
    expect(isSuccessfulSandboxResult(undefined)).toBe(false)
  })
})

describe('toSandboxCmdResult', () => {
  it('normalizes a full result', () => {
    expect(toSandboxCmdResult({ ok: true, exitCode: 0, stdout: 'out', stderr: 'err' })).toEqual({
      ok: true,
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
      error: undefined,
    })
  })

  it('provides defaults for missing fields', () => {
    const result = toSandboxCmdResult({})
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('infers exitCode 0 when ok is true and exitCode missing', () => {
    expect(toSandboxCmdResult({ ok: true }).exitCode).toBe(0)
  })

  it('handles null input', () => {
    expect(toSandboxCmdResult(null).ok).toBe(false)
  })
})

describe('shouldAutoLintAfterBuild', () => {
  it('returns true for e2b mode after build', () => {
    expect(shouldAutoLintAfterBuild({ workspaceMode: 'e2b', sawBuild: true })).toBe(true)
  })

  it('returns false for host mode', () => {
    expect(shouldAutoLintAfterBuild({ workspaceMode: 'host', sawBuild: true })).toBe(false)
  })

  it('returns false when no build was detected', () => {
    expect(shouldAutoLintAfterBuild({ workspaceMode: 'e2b', sawBuild: false })).toBe(false)
  })

  it('returns false when explicitly disabled', () => {
    expect(shouldAutoLintAfterBuild({ workspaceMode: 'e2b', sawBuild: true, enabledRaw: 'false' })).toBe(false)
  })

  it('returns true for any non-"false" enabledRaw', () => {
    expect(shouldAutoLintAfterBuild({ workspaceMode: 'e2b', sawBuild: true, enabledRaw: 'true' })).toBe(true)
    expect(shouldAutoLintAfterBuild({ workspaceMode: 'e2b', sawBuild: true, enabledRaw: '1' })).toBe(true)
  })
})

describe('resolveAutoLintMaxPasses', () => {
  it('defaults to 2 when undefined', () => {
    expect(resolveAutoLintMaxPasses(undefined)).toBe(2)
  })

  it('parses valid numbers', () => {
    expect(resolveAutoLintMaxPasses('3')).toBe(3)
    expect(resolveAutoLintMaxPasses('0')).toBe(0)
  })

  it('clamps to [0, 5]', () => {
    expect(resolveAutoLintMaxPasses('-1')).toBe(0)
    expect(resolveAutoLintMaxPasses('10')).toBe(5)
  })

  it('returns default for non-numeric', () => {
    expect(resolveAutoLintMaxPasses('abc')).toBe(2)
  })

  it('truncates decimals', () => {
    expect(resolveAutoLintMaxPasses('2.9')).toBe(2)
  })
})

describe('resolveAutoLintTimeoutMs', () => {
  it('defaults to 8 minutes when undefined', () => {
    expect(resolveAutoLintTimeoutMs(undefined)).toBe(8 * 60_000)
  })

  it('parses valid positive numbers', () => {
    expect(resolveAutoLintTimeoutMs('120000')).toBe(120000)
  })

  it('returns default for zero or negative', () => {
    expect(resolveAutoLintTimeoutMs('0')).toBe(8 * 60_000)
    expect(resolveAutoLintTimeoutMs('-5000')).toBe(8 * 60_000)
  })
})

describe('truncateForModel', () => {
  it('returns text unchanged when within limit', () => {
    expect(truncateForModel('short', 100)).toBe('short')
  })

  it('truncates and appends marker when over limit', () => {
    const result = truncateForModel('A'.repeat(200), 50)
    expect(result.startsWith('A'.repeat(50))).toBe(true)
    expect(result).toContain('[truncated]')
  })

  it('returns text unchanged for zero/negative limit', () => {
    expect(truncateForModel('any', 0)).toBe('any')
    expect(truncateForModel('any', -1)).toBe('any')
  })
})

describe('formatLintFailureForModel', () => {
  it('includes command, exit code, stdout, and stderr', () => {
    const result = formatLintFailureForModel({
      result: { ok: false, exitCode: 1, stdout: 'warnings', stderr: 'error line' },
      cmd: 'bun run lint',
    })
    expect(result).toContain('bun run lint')
    expect(result).toContain('Exit code: 1')
    expect(result).toContain('warnings')
    expect(result).toContain('error line')
  })

  it('omits empty stdout/stderr sections', () => {
    const result = formatLintFailureForModel({
      result: { ok: false, exitCode: 2, stdout: '', stderr: '' },
      cmd: 'bun run lint',
    })
    expect(result).not.toContain('stdout:')
    expect(result).not.toContain('stderr:')
  })

  it('respects maxChars truncation', () => {
    const result = formatLintFailureForModel({
      result: { ok: false, exitCode: 1, stdout: 'X'.repeat(20000), stderr: '' },
      cmd: 'bun run lint',
      maxChars: 100,
    })
    expect(result).toContain('[truncated]')
    expect(result.length).toBeLessThan(200)
  })
})
