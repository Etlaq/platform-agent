import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const invokeMock = vi.fn()
const createDeepAgentMock = vi.fn(() => ({ invoke: invokeMock }))
const appendAgentsNoteMock = vi.fn(async () => ({ ok: true as const }))

vi.mock('deepagents', () => {
  class FilesystemBackend {
    constructor(_params: unknown) {}
  }

  class StateBackend {
    constructor(_runtime: unknown) {}
    lsInfo() {}
    read() {}
    readRaw() {}
    write() {}
    edit() {}
    globInfo() {}
    grepRaw() {}
    uploadFiles() {}
    downloadFiles() {}
  }

  class CompositeBackend {
    constructor(_base: unknown, _mounts: unknown) {}
  }

  return {
    FilesystemBackend,
    StateBackend,
    CompositeBackend,
    createDeepAgent: createDeepAgentMock,
  }
})

vi.mock('../../agent/agentsMd', () => ({
  appendAgentsNote: appendAgentsNoteMock,
  ensureAgentsMd: vi.fn(async () => ({ ok: true as const })),
  loadAgentsMdTemplate: vi.fn(() => ''),
}))

vi.mock('../../agent/provider', () => ({
  resolveModelSelection: () => ({
    provider: 'openai',
    model: 'gpt-5',
    source: 'default',
  }),
}))

vi.mock('../../agent/runtime/modelFactory', () => ({
  normalizeModelName: (_provider: string, model: string) => model,
  createModel: () => ({ id: 'mock-model' }),
}))

vi.mock('../../agent/runtime/mcp', () => ({
  loadMcpTools: async () => ({ tools: [], client: null }),
}))

describe('runAgent aborted runs', () => {
  const originalEnv = { ...process.env }
  let tmpRoot: string | null = null
  let tmpWorkspace: string | null = null

  beforeEach(() => {
    invokeMock.mockReset()
    createDeepAgentMock.mockClear()
    appendAgentsNoteMock.mockClear()

    process.env = {
      ...originalEnv,
      SEED_AGENTS_MD: 'false',
      ALLOW_HOST_INSTALLS: 'false',
    }

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-v2-abort-test-'))
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-v2-ws-test-'))

    process.env.WORKSPACE_ROOT = tmpWorkspace
    process.env.MEMORY_DIR = path.join(tmpRoot, 'memories')
    process.env.SKILLS_DIR = path.join(tmpRoot, 'skills')
    process.env.ROLLBACK_DIR = path.join(tmpRoot, 'rollbacks')
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
    if (tmpWorkspace) fs.rmSync(tmpWorkspace, { recursive: true, force: true })
    tmpRoot = null
    tmpWorkspace = null
  })

  it('does not append AGENTS.md notes for user-aborted runs', async () => {
    const ac = new AbortController()
    // Import with a query to bypass other test files' `vi.mock('../../agent/runAgent', ...)`.
    const { runAgent } = await import('../../agent/runAgent?abort-note-test')

    await expect(
      runAgent({
        prompt: 'Abort this run',
        runId: 'test-run-abort',
        signal: ac.signal,
        onEvent: (event) => {
          if (event.type !== 'status') return
          const payload = event.payload as { status?: string } | null
          if (payload?.status === 'phase_started') {
            ac.abort()
          }
        },
      }),
    ).rejects.toMatchObject({ name: 'RunAbortedError' })

    expect(invokeMock).not.toHaveBeenCalled()
    expect(appendAgentsNoteMock).not.toHaveBeenCalled()
  })
})
