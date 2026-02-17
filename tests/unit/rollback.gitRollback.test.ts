import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'bun:test'

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

async function loadRollbackModule() {
  moduleSeq += 1
  return import(`../../agent/rollback/gitRollback?rollback-git-${moduleSeq}`)
}

describe('agent/rollback/gitRollback', () => {
  beforeEach(() => {
    spawnQueue.length = 0
    spawnMock.mockClear()
  })

  it('lists recent commits from git history', async () => {
    spawnQueue.push(
      { code: 0, stdout: 'true\n' },
      { code: 0, stdout: 'headsha\n' },
      { code: 0, stdout: '' },
      { code: 0, stdout: 'master\n' },
      { code: 0, stdout: 'headsha\u001fhead\u001f2026-02-17T22:00:00.000Z\u001fAgent\u001fCurrent commit\noldsha\u001fold\u001f2026-02-17T21:00:00.000Z\u001fAgent\u001fOlder commit\n' },
    )

    const { listRollbackCommits } = await loadRollbackModule()
    const out = await listRollbackCommits({
      workspaceRoot: '/workspace',
      limit: 2,
    })

    expect(out.head).toBe('headsha')
    expect(out.branch).toBe('master')
    expect(out.clean).toBe(true)
    expect(out.commits).toHaveLength(2)
    expect(out.commits[0]).toEqual({
      sha: 'headsha',
      shortSha: 'head',
      committedAt: '2026-02-17T22:00:00.000Z',
      author: 'Agent',
      subject: 'Current commit',
      isHead: true,
    })
    expect(spawnMock.mock.calls[4]?.[1]).toEqual(['log', '--max-count=2', '--pretty=format:%H%x1f%h%x1f%cI%x1f%an%x1f%s'])
  })

  it('creates a rollback commit that restores selected snapshot as latest', async () => {
    spawnQueue.push(
      { code: 0, stdout: 'true\n' }, // repo check
      { code: 0, stdout: '' }, // clean check
      { code: 0, stdout: 'currenthead\n' }, // current head
      { code: 0, stdout: 'targethead\n' }, // target commit resolve
      { code: 0, stdout: 'src/a.ts\u0000src/b.ts\u0000' }, // files at current head
      { code: 0, stdout: 'src/a.ts\u0000' }, // files at target commit
      { code: 0 }, // checkout target -- .
      { code: 0 }, // add -A
      { code: 0, stdout: 'src/a.ts\nsrc/b.ts\n' }, // changed files
      { code: 1 }, // diff --cached --quiet (has changes)
      { code: 0, stdout: '[master newhead] chore(rollback): restore snapshot targethead\n' }, // commit
      { code: 0, stdout: 'newhead\n' }, // new head
    )

    const { rollbackToCommit } = await loadRollbackModule()
    const out = await rollbackToCommit({
      workspaceRoot: '/workspace',
      commitSha: 'targethead',
    })

    expect(out).toEqual({
      ok: true,
      fromHead: 'currenthead',
      targetCommit: 'targethead',
      newHead: 'newhead',
      createdCommit: true,
      changedFiles: 2,
      noChanges: false,
      commitMessage: 'chore(rollback): restore snapshot targethead',
    })
    expect(spawnMock.mock.calls[10]?.[1]).toEqual(['commit', '-m', 'chore(rollback): restore snapshot targethead', '--no-verify'])
  })

  it('fails rollback when working tree is dirty', async () => {
    spawnQueue.push(
      { code: 0, stdout: 'true\n' },
      { code: 0, stdout: ' M src/a.ts\n' },
    )

    const { rollbackToCommit } = await loadRollbackModule()
    await expect(
      rollbackToCommit({
        workspaceRoot: '/workspace',
        commitSha: 'abc123',
      })
    ).rejects.toThrow('working tree must be clean before rollback')
  })
})
