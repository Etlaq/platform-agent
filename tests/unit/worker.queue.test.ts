import { beforeEach, describe, expect, it, vi } from 'bun:test'

interface RunView {
  id: string
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled'
  prompt: string
  input: unknown | null
  provider: string | null
  model: string | null
  workspaceBackend: 'host' | 'e2b' | null
  sandboxId: string | null
}

interface JobView {
  attempts: number
  maxAttempts: number
}

interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

interface AgentResult {
  output: string
  provider: string
  model: string
  modelSource: string
  usage?: Usage
  durationMs?: number
}

const subscriptionHandlers: Array<(event: { runId: string }) => Promise<void>> = []
const publishMock = vi.fn(async (_payload: { runId: string }) => undefined)

const addArtifactMock = vi.fn(async (_params: {
  runId: string
  name: string
  path: string
  mime?: string
  size?: number
}) => undefined)
const cancelJobByRunIdMock = vi.fn(async (_runId: string) => undefined)
const completeRunMock = vi.fn(async (
  _id: string,
  _output: string,
  _meta?: {
    provider?: string
    model?: string
    modelSource?: string
    usage?: Usage
    cachedInputTokens?: number
    reasoningOutputTokens?: number
    durationMs?: number
  },
) => undefined)
const failRunMock = vi.fn(async (_id: string, _error: string) => undefined)
const getJobByRunIdMock = vi.fn(async (_runId: string) => null as JobView | null)
const getRunMock = vi.fn(async (_runId: string) => null as RunView | null)
const claimRunForExecutionMock = vi.fn(async (_runId: string) => true)
const insertEventWithNextSeqMock = vi.fn(async (_params: {
  runId: string
  type: string
  payload: unknown
}) => undefined)
const markJobFailedMock = vi.fn(async (_runId: string, _attempts: number, _delaySeconds: number) => undefined)
const queueRunForRetryMock = vi.fn(async (_id: string) => undefined)
const setRunExecutionAttemptMock = vi.fn(async (_runId: string, _attempt: number, _maxAttempts: number) => undefined)
const setRunSandboxIdMock = vi.fn(async (_runId: string, _sandboxId: string | null) => undefined)
const setRunWorkspaceBackendMock = vi.fn(async (_runId: string, _workspaceBackend: 'host' | 'e2b') => undefined)
const setJobStatusMock = vi.fn(async (_runId: string, _status: string) => undefined)
const updateRunStatusMock = vi.fn(async (_id: string, _status: string) => undefined)
const updateRunMetaMock = vi.fn(async (_runId: string, _meta: unknown) => undefined)

const runAgentMock = vi.fn(async (_params: {
  prompt: string
  input?: unknown
  provider?: string
  model?: string
  runId: string
  workspaceBackend?: 'host' | 'e2b'
  signal: AbortSignal
  onEvent: (event: { type: 'token' | 'tool' | 'status'; payload: unknown }) => void
}) => null as AgentResult | null)
const isRunAbortedErrorMock = vi.fn((_error: unknown) => false)
const commitRunToGitMock = vi.fn(async (_params: {
  runId: string
  workspaceBackend?: 'host' | 'e2b' | null
}) => ({ ok: false, skipped: 'no_changes' as const }))

vi.mock('encore.dev/pubsub', () => {
  class Topic<T extends { runId: string }> {
    constructor(_name: string, _opts: { deliveryGuarantee: 'at-least-once' }) {}

    publish(payload: T) {
      return publishMock(payload)
    }
  }

  class Subscription {
    constructor(
      _topic: unknown,
      _name: string,
      params: { handler: (event: { runId: string }) => Promise<void> },
    ) {
      subscriptionHandlers.push(params.handler)
    }
  }

  return { Topic, Subscription }
})

vi.mock('encore.dev/config', () => ({
  secret: () => () => '',
}))

vi.mock('../../data/db', () => ({
  addArtifact: addArtifactMock,
  cancelJobByRunId: cancelJobByRunIdMock,
  claimRunForExecution: claimRunForExecutionMock,
  completeRun: completeRunMock,
  failRun: failRunMock,
  getJobByRunId: getJobByRunIdMock,
  getRun: getRunMock,
  insertEventWithNextSeq: insertEventWithNextSeqMock,
  markJobFailed: markJobFailedMock,
  queueRunForRetry: queueRunForRetryMock,
  setRunExecutionAttempt: setRunExecutionAttemptMock,
  setRunSandboxId: setRunSandboxIdMock,
  setRunWorkspaceBackend: setRunWorkspaceBackendMock,
  setJobStatus: setJobStatusMock,
  updateRunMeta: updateRunMetaMock,
  updateRunStatus: updateRunStatusMock,
}))

vi.mock('../../agent/runAgent', () => ({
  isRunAbortedError: isRunAbortedErrorMock,
  runAgent: runAgentMock,
  RunAbortedError: class RunAbortedError extends Error {
    constructor(message = 'Run aborted') {
      super(message)
      this.name = 'RunAbortedError'
    }
  },
}))

vi.mock('../../worker/gitCommit', () => ({
  commitRunToGit: commitRunToGitMock,
}))

vi.mock('../../storage/storage', () => ({
  putBinaryObject: vi.fn(async (_key: string, _payload: Buffer, _contentType?: string) => undefined),
}))

vi.mock('../../common/sandboxZip', () => ({
  buildSandboxZipBuffer: vi.fn(async (_sb: unknown, _rootDir: string) => ({ buffer: Buffer.alloc(0), fileCount: 0 })),
}))

describe('worker/queue completion persistence', () => {
  beforeEach(() => {
    subscriptionHandlers.length = 0
    publishMock.mockClear()
    addArtifactMock.mockClear()
    cancelJobByRunIdMock.mockClear()
    completeRunMock.mockClear()
    failRunMock.mockClear()
    getJobByRunIdMock.mockClear()
    getRunMock.mockClear()
    claimRunForExecutionMock.mockClear()
    insertEventWithNextSeqMock.mockClear()
    markJobFailedMock.mockClear()
    queueRunForRetryMock.mockClear()
    setRunExecutionAttemptMock.mockClear()
    setRunSandboxIdMock.mockClear()
    setRunWorkspaceBackendMock.mockClear()
    setJobStatusMock.mockClear()
    updateRunStatusMock.mockClear()
    updateRunMetaMock.mockClear()
    runAgentMock.mockClear()
    isRunAbortedErrorMock.mockClear()
    commitRunToGitMock.mockClear()
  })

  it('passes resolved provider/model into completeRun with usage/duration', async () => {
    const run: RunView = {
      id: 'run-1',
      status: 'queued',
      prompt: 'build feature',
      input: { task: 'feature' },
      provider: null,
      model: null,
      workspaceBackend: 'host',
      sandboxId: null,
    }

    getRunMock.mockResolvedValue(run)
    getJobByRunIdMock.mockResolvedValue({ attempts: 0, maxAttempts: 3 })
    runAgentMock.mockResolvedValue({
      output: 'done',
      provider: 'openai',
      model: 'gpt-5',
      modelSource: 'default',
      usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
      durationMs: 640,
    })

    await import('../../worker/queue?worker-queue-unit')
    expect(subscriptionHandlers).toHaveLength(1)

    await subscriptionHandlers[0]({ runId: 'run-1' })

    expect(completeRunMock).toHaveBeenCalledTimes(1)
    expect(completeRunMock).toHaveBeenCalledWith('run-1', 'done', {
      provider: 'openai',
      model: 'gpt-5',
      modelSource: 'default',
      usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
      cachedInputTokens: undefined,
      reasoningOutputTokens: undefined,
      durationMs: 640,
    })

    expect(setJobStatusMock).toHaveBeenCalledWith('run-1', 'succeeded')
    expect(commitRunToGitMock).toHaveBeenCalledWith({
      runId: 'run-1',
      workspaceBackend: 'host',
    })
    expect(setRunWorkspaceBackendMock).toHaveBeenCalledTimes(0)
  })
})
