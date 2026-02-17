import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'

interface MockChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
}

interface SpawnResult {
  code: number
  stdout?: string
  stderr?: string
}

const spawnQueue: SpawnResult[] = []
const spawnMock = vi.fn(
  (_cmd: string, _args: string[], _opts: Record<string, unknown>) => {
    const next = spawnQueue.shift()
    if (!next) {
      throw new Error('No mocked spawn result available')
    }

    const child = new EventEmitter() as MockChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()

    queueMicrotask(() => {
      if (next.stdout) child.stdout.emit('data', Buffer.from(next.stdout))
      if (next.stderr) child.stderr.emit('data', Buffer.from(next.stderr))
      child.emit('close', next.code)
    })

    return child
  }
)

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

let moduleSeq = 0

async function loadGitCommitModule() {
  moduleSeq += 1
  return import(`../../worker/gitCommit?worker-git-commit-${moduleSeq}`)
}

describe('worker/gitCommit', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.WORKSPACE_ROOT = process.cwd()
    spawnQueue.length = 0
    spawnMock.mockClear()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('skips when auto git commit is disabled', async () => {
    process.env.AUTO_GIT_COMMIT = 'false'
    const { commitRunToGit } = await loadGitCommitModule()
    const result = await commitRunToGit({ runId: 'run-disabled', workspaceBackend: 'host' })
    expect(result).toEqual({ ok: false, skipped: 'disabled' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('skips for non-host workspace backends', async () => {
    const { commitRunToGit } = await loadGitCommitModule()
    const result = await commitRunToGit({ runId: 'run-e2b', workspaceBackend: 'e2b' })
    expect(result).toEqual({ ok: false, skipped: 'non_host_workspace' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('returns skipped when workspace is not a git repo', async () => {
    spawnQueue.push({ code: 1, stderr: 'not a git repo' })
    const { commitRunToGit } = await loadGitCommitModule()
    const result = await commitRunToGit({ runId: 'run-not-repo', workspaceBackend: 'host' })
    expect(result).toEqual({ ok: false, skipped: 'not_git_repo' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['rev-parse', '--is-inside-work-tree'])
  })

  it('creates a commit when tracked changes are present', async () => {
    spawnQueue.push(
      { code: 0, stdout: 'true\n' }, // rev-parse --is-inside-work-tree
      { code: 0 }, // git add -A
      { code: 1 }, // git diff --cached --quiet (changes present)
      { code: 0, stdout: '[master abc123] chore(agent): apply run run-commit\n' }, // commit
      { code: 0, stdout: 'abc123def456\n' }, // rev-parse HEAD
    )

    const { commitRunToGit } = await loadGitCommitModule()
    const result = await commitRunToGit({ runId: 'run-commit', workspaceBackend: 'host' })

    expect(result).toEqual({
      ok: true,
      commitSha: 'abc123def456',
    })
    expect(spawnMock).toHaveBeenCalledTimes(5)
    expect(spawnMock.mock.calls[1]?.[1]).toEqual(['add', '-A'])
    expect(spawnMock.mock.calls[2]?.[1]).toEqual(['diff', '--cached', '--quiet'])
    expect(spawnMock.mock.calls[3]?.[1]).toEqual(['commit', '-m', 'chore(agent): apply run run-commit', '--no-verify'])
  })

  it('returns skipped when there are no staged changes after add', async () => {
    spawnQueue.push(
      { code: 0, stdout: 'true\n' },
      { code: 0 },
      { code: 0 }, // diff --cached --quiet (no changes)
    )

    const { commitRunToGit } = await loadGitCommitModule()
    const result = await commitRunToGit({ runId: 'run-no-changes', workspaceBackend: 'host' })

    expect(result).toEqual({ ok: false, skipped: 'no_changes' })
    expect(spawnMock).toHaveBeenCalledTimes(3)
  })
})
