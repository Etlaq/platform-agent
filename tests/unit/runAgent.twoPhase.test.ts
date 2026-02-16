import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const invokeMock = vi.fn()
const createDeepAgentMock = vi.fn(() => ({ invoke: invokeMock }))
const sandboxRunMock = vi.fn()
const sandboxGetHostMock = vi.fn(() => 'sandbox-host')
const sandboxCreateMock = vi.fn(async () => ({
  sandboxId: 'sandbox-test-id',
  commands: { run: sandboxRunMock },
  getHost: sandboxGetHostMock,
}))

interface MockInvokeConfig {
  callbacks?: Array<{
    handleToolStart?: (tool: { name?: string }, input: unknown) => void
    handleToolEnd?: (output: unknown, runId: string) => void
  }>
  tags?: string[]
  metadata?: { phase?: string }
}

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

vi.mock('@e2b/code-interpreter', () => ({
  Sandbox: { create: sandboxCreateMock },
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

describe('runAgent two-phase flow', () => {
  const originalEnv = { ...process.env }
  let tmpRuntimeRoot: string | null = null

  beforeEach(() => {
    invokeMock.mockReset()
    createDeepAgentMock.mockClear()
    sandboxRunMock.mockReset()
    sandboxGetHostMock.mockClear()
    sandboxCreateMock.mockClear()
    process.env = {
      ...originalEnv,
      SEED_AGENTS_MD: 'false',
      ALLOW_HOST_INSTALLS: 'false',
    }

    tmpRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-v2-test-'))
    process.env.MEMORY_DIR = path.join(tmpRuntimeRoot, 'memories')
    process.env.SKILLS_DIR = path.join(tmpRuntimeRoot, 'skills')
    process.env.ROLLBACK_DIR = path.join(tmpRuntimeRoot, 'rollbacks')

    delete process.env.E2B_API_KEY
    delete process.env.E2B_TEMPLATE
    delete process.env.AUTO_LINT_AFTER_BUILD
    delete process.env.AUTO_LINT_FIX_MAX_PASSES
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tmpRuntimeRoot) {
      fs.rmSync(tmpRuntimeRoot, { recursive: true, force: true })
      tmpRuntimeRoot = null
    }
  })

  it('parses JSON plan output', async () => {
    const { parsePlanSnapshot } = await import('../../agent/runAgent?run-agent-two-phase')
    const parsed = parsePlanSnapshot(
      [
        'Plan output',
        '```json',
        '{"summary":"Ship feature","todos":[{"id":"1","title":"Add API"},{"id":"2","title":"Add tests"}]}',
        '```',
      ].join('\n')
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.summary).toBe('Ship feature')
    expect(parsed?.todos).toHaveLength(2)
    expect(parsed?.todos[0]?.title).toBe('Add API')
  }, 20_000)

  it('falls back to markdown todo parsing when JSON is absent', async () => {
    const { parsePlanSnapshot } = await import('../../agent/runAgent?run-agent-two-phase')
    const parsed = parsePlanSnapshot(
      [
        'Implementation plan',
        '- add endpoint schema',
        '- wire queue worker',
        '1. add tests',
      ].join('\n')
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.todos).toHaveLength(3)
  })

  it('runs plan then build and emits phase status events', async () => {
    invokeMock
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content:
              '```json\n{"summary":"Implement change","todos":[{"id":"1","title":"Update service"},{"id":"2","title":"Add tests"}]}\n```',
          },
        ],
      }))
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: 'Implemented the requested change.',
          },
        ],
      }))

    const events: Array<{ type: 'token' | 'tool' | 'status'; payload: unknown }> = []
    const { runAgent } = await import('../../agent/runAgent?run-agent-two-phase')
    const result = await runAgent({
      prompt: 'Implement the feature',
      runId: 'test-run-id',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(createDeepAgentMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledTimes(2)

    const firstCallMessages = invokeMock.mock.calls[0]?.[0]?.messages as Array<{ content?: string }>
    const secondCallMessages = invokeMock.mock.calls[1]?.[0]?.messages as Array<{ content?: string }>

    expect(firstCallMessages[0]?.content ?? '').toContain('phase 1 (plan)')
    expect(secondCallMessages[secondCallMessages.length - 1]?.content ?? '').toContain('phase 2 (build)')

    const statusPayloads = events
      .filter((event) => event.type === 'status')
      .map((event) => event.payload as Record<string, unknown>)
    const statuses = statusPayloads.map((payload) => payload.status)

    expect(statuses).toContain('phase_started')
    expect(statuses).toContain('plan_ready')
    expect(statuses).toContain('phase_transition')
    expect(statuses).toContain('phase_completed')

    const planReady = statusPayloads.find((payload) => payload.status === 'plan_ready')
    expect(planReady?.summary).toBe('Implement change')
    expect(Array.isArray(planReady?.todos)).toBe(true)

    expect(result.plan?.summary).toBe('Implement change')
    expect(result.output).toContain('Implemented the requested change.')
  })

  it('falls back to a synthetic plan when phase 1 has no JSON or todos', async () => {
    invokeMock
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: 'I will inspect the code and then implement the requested update.',
          },
        ],
      }))
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: 'Implemented with best effort.',
          },
        ],
      }))

    const events: Array<{ type: 'token' | 'tool' | 'status'; payload: unknown }> = []
    const { runAgent } = await import('../../agent/runAgent?run-agent-two-phase')
    const result = await runAgent({
      prompt: 'Ship the refactor',
      runId: 'test-run-fallback',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(result.plan?.summary).toBe('I will inspect the code and then implement the requested update.')
    expect(result.plan?.todos).toHaveLength(1)
    expect(result.plan?.todos[0]?.title).toBe('Implement requested change')
    expect(result.plan?.todos[0]?.details).toContain('No structured todos were parsed')

    const planReady = events
      .filter((event) => event.type === 'status')
      .map((event) => event.payload as Record<string, unknown>)
      .find((payload) => payload.status === 'plan_ready')

    const planReadyTodos = (planReady?.todos as Array<{ title?: string }> | undefined) ?? []
    expect(planReadyTodos[0]?.title).toBe('Implement requested change')
  })

  it('emits plan policy warning when plan phase triggers a mutating project action', async () => {
    invokeMock
      .mockImplementationOnce(
        async ({ messages }: { messages: unknown[] }, config: MockInvokeConfig) => {
          const callback = config.callbacks?.[0]
          callback?.handleToolStart?.({ name: 'project_actions' }, { action: 'run_install' })
          return {
            messages: [
              ...messages,
              {
                role: 'assistant',
                content:
                  '```json\n{"summary":"Plan ready","todos":[{"id":"1","title":"Apply update"}]}\n```',
              },
            ],
          }
        }
      )
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: 'Applied update.',
          },
        ],
      }))

    const events: Array<{ type: 'token' | 'tool' | 'status'; payload: unknown }> = []
    const { runAgent } = await import('../../agent/runAgent?run-agent-two-phase')
    await runAgent({
      prompt: 'Implement safely',
      runId: 'test-run-warning',
      onEvent: (event) => {
        events.push(event)
      },
    })

    const warning = events
      .filter((event) => event.type === 'status')
      .map((event) => event.payload as Record<string, unknown>)
      .find((payload) => payload.status === 'plan_policy_warning')

    expect(warning).toMatchObject({
      status: 'plan_policy_warning',
      phase: 'plan',
      tool: 'project_actions',
      detail: 'project_actions:run_install',
    })
  })

  it('tags auto-lint fix invocations as build phase', async () => {
    process.env.E2B_API_KEY = 'test-key'
    process.env.E2B_TEMPLATE = 'test-template'
    process.env.AUTO_LINT_AFTER_BUILD = 'true'
    process.env.AUTO_LINT_FIX_MAX_PASSES = '1'

    sandboxRunMock
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'lint failed',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'lint clean',
        stderr: '',
      })

    invokeMock
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content:
              '```json\n{"summary":"Execute build","todos":[{"id":"1","title":"Build project"}]}\n```',
          },
        ],
      }))
      .mockImplementationOnce(
        async ({ messages }: { messages: unknown[] }, config: MockInvokeConfig) => {
          const callback = config.callbacks?.[0]
          callback?.handleToolStart?.({ name: 'sandbox_cmd' }, { cmd: 'bun run build' })
          callback?.handleToolEnd?.(
            { ok: true, exitCode: 0, stdout: 'build ok', stderr: '' },
            'tool-build-success'
          )
          return {
            messages: [
              ...messages,
              {
                role: 'assistant',
                content: 'Build completed.',
              },
            ],
          }
        }
      )
      .mockImplementationOnce(async ({ messages }: { messages: unknown[] }) => ({
        messages: [
          ...messages,
          {
            role: 'assistant',
            content: 'Fixed lint issues.',
          },
        ],
      }))

    const events: Array<{ type: 'token' | 'tool' | 'status'; payload: unknown }> = []
    const { runAgent } = await import('../../agent/runAgent?run-agent-two-phase')
    await runAgent({
      prompt: 'Ship the feature',
      runId: 'test-run-auto-lint',
      workspaceBackend: 'e2b',
      onEvent: (event) => {
        events.push(event)
      },
    })

    expect(sandboxCreateMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(sandboxRunMock).toHaveBeenCalledTimes(2)
    expect(sandboxRunMock).toHaveBeenNthCalledWith(
      1,
      'bun run lint',
      expect.objectContaining({ cwd: '/home/user' })
    )
    expect(sandboxRunMock).toHaveBeenNthCalledWith(
      2,
      'bun run lint',
      expect.objectContaining({ cwd: '/home/user' })
    )

    const autoLintInvokeConfig = invokeMock.mock.calls[2]?.[1] as MockInvokeConfig | undefined
    expect(autoLintInvokeConfig?.tags).toContain('phase:build')
    expect(autoLintInvokeConfig?.metadata?.phase).toBe('build')

    const statuses = events
      .filter((event) => event.type === 'status')
      .map((event) => (event.payload as Record<string, unknown>).status)
    expect(statuses).toContain('auto_lint_started')
    expect(statuses).toContain('auto_lint_fix_attempt')
    expect(statuses).toContain('auto_lint_passed')
  })
})
