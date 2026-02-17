import { beforeEach, describe, expect, it, vi } from 'bun:test'

interface PersistedEvent {
  id: number
  seq: number
  type: string
  payload: unknown
  ts: string
}

interface RunRecordShape {
  id: string
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled'
  projectId: string
  idempotencyKey: string | null
  prompt: string
  input: unknown
  provider: string | null
  model: string | null
  workspaceBackend: 'host' | 'e2b' | null
  sandboxId: string | null
  output: string | null
  error: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cachedInputTokens: number | null
  reasoningOutputTokens: number | null
  durationMs: number | null
  attempt: number
  maxAttempts: number
  estimatedCostUsd: number | null
  costCurrency: string | null
  pricingVersion: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

interface RunRequestedEvent {
  runId: string
}

interface OnEventPayload {
  type: 'status' | 'token' | 'tool'
  payload: unknown
}

interface RunAgentParams {
  runId: string
  onEvent?: (event: OnEventPayload) => void
}

interface InsertEventParams {
  runId: string
  type: string
  payload: unknown
}

const persistedEvents: PersistedEvent[] = []
let subscriptionHandler: ((event: RunRequestedEvent) => Promise<void>) | null = null

const topicPublishMock = vi.fn(async (_event: RunRequestedEvent) => undefined)
const cancelJobByRunIdMock = vi.fn(async (_runId: string) => undefined)
const completeRunMock = vi.fn(async (_runId: string, _output: string, _meta?: unknown) => undefined)
const failRunMock = vi.fn(async (_runId: string, _error: string) => undefined)
const getJobByRunIdMock = vi.fn(async (_runId: string) => ({ attempts: 0, maxAttempts: 3 }))
const getRunMock = vi.fn(async (_runId: string) => null as RunRecordShape | null)
const claimRunForExecutionMock = vi.fn(async (_runId: string) => true)
const insertEventWithNextSeqMock = vi.fn(async ({ type, payload }: InsertEventParams) => {
  const maxId = persistedEvents.reduce((m, event) => Math.max(m, event.id), 0)
  const maxSeq = persistedEvents.reduce((m, event) => Math.max(m, event.seq), 0)
  const nextId = maxId + 1
  const nextSeq = maxSeq + 1

  // Async boundary to mimic DB writes while preserving queue ordering guarantees.
  await Promise.resolve()

  persistedEvents.push({
    id: nextId,
    seq: nextSeq,
    type,
    payload,
    ts: new Date(1_700_000_000_000 + nextId * 1_000).toISOString(),
  })
})
const markJobFailedMock = vi.fn(async (_runId: string, _attempts: number, _delaySeconds: number) => undefined)
const queueRunForRetryMock = vi.fn(async (_runId: string) => undefined)
const setRunExecutionAttemptMock = vi.fn(async (_runId: string, _attempt: number, _maxAttempts: number) => undefined)
const setRunSandboxIdMock = vi.fn(async (_runId: string, _sandboxId: string | null) => undefined)
const setJobStatusMock = vi.fn(async (_runId: string, _status: string) => undefined)
const updateRunStatusMock = vi.fn(async (_runId: string, _status: string) => undefined)
const updateRunMetaMock = vi.fn(async (_runId: string, _meta: unknown) => undefined)
const runAgentMock = vi.fn(async (_params: RunAgentParams) => ({
  output: 'done output',
  provider: 'openai',
  model: 'gpt-5',
  modelSource: 'default',
  usage: { inputTokens: 11, outputTokens: 19, totalTokens: 30 },
  durationMs: 1450,
}))
const commitRunToGitMock = vi.fn(async (_params: {
  runId: string
  workspaceBackend?: 'host' | 'e2b' | null
}) => ({ ok: false, skipped: 'no_changes' as const }))

vi.mock('encore.dev/pubsub', () => {
  class Topic<T> {
    constructor(_name: string, _opts: unknown) {}
    async publish(event: T) {
      await topicPublishMock(event)
    }
  }

  class Subscription<T> {
    constructor(_topic: unknown, _name: string, opts: { handler: (event: T) => Promise<void> }) {
      subscriptionHandler = opts.handler as (event: RunRequestedEvent) => Promise<void>
    }
  }

  return { Topic, Subscription }
})

vi.mock('encore.dev/config', () => ({
  secret: () => () => '',
}))

vi.mock('../../data/db', () => ({
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
  setJobStatus: setJobStatusMock,
  updateRunMeta: updateRunMetaMock,
  updateRunStatus: updateRunStatusMock,
}))

vi.mock('../../agent/runAgent', () => ({
  isRunAbortedError: () => false,
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

function buildRun(runId: string): RunRecordShape {
  const now = new Date('2026-02-12T00:00:00.000Z').toISOString()
  return {
    id: runId,
    status: 'queued',
    projectId: 'default',
    idempotencyKey: `lifecycle-${runId}`,
    prompt: 'Implement queue lifecycle tests',
    input: null,
    provider: 'openai',
    model: 'gpt-5',
    workspaceBackend: 'host',
    sandboxId: null,
    output: null,
    error: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    durationMs: null,
    attempt: 0,
    maxAttempts: 3,
    estimatedCostUsd: null,
    costCurrency: 'USD',
    pricingVersion: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

function seedQueuedEvent() {
  persistedEvents.push({
    id: 1,
    seq: 1,
    type: 'status',
    payload: { status: 'queued' },
    ts: new Date('2026-02-12T00:00:00.000Z').toISOString(),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function timelineLabelFromEvent(event: PersistedEvent) {
  if (event.type !== 'status') return event.type
  if (!isRecord(event.payload)) return 'status'
  const status = typeof event.payload.status === 'string' ? event.payload.status : 'status'
  const phase = typeof event.payload.phase === 'string' ? event.payload.phase : null
  if (status === 'phase_started' && phase) return `phase_started(${phase})`
  if (status === 'phase_completed' && phase) return `phase_completed(${phase})`
  return status
}

describe('worker queue event lifecycle', () => {
  beforeEach(() => {
    persistedEvents.length = 0
    subscriptionHandler = null

    topicPublishMock.mockClear()
    cancelJobByRunIdMock.mockClear()
    completeRunMock.mockClear()
    failRunMock.mockClear()
    getJobByRunIdMock.mockReset()
    getRunMock.mockReset()
    claimRunForExecutionMock.mockClear()
    insertEventWithNextSeqMock.mockClear()
    markJobFailedMock.mockClear()
    queueRunForRetryMock.mockClear()
    setRunExecutionAttemptMock.mockClear()
    setRunSandboxIdMock.mockClear()
    setJobStatusMock.mockClear()
    updateRunMetaMock.mockClear()
    updateRunStatusMock.mockClear()
    runAgentMock.mockReset()
    commitRunToGitMock.mockClear()

    runAgentMock.mockImplementation(async ({ runId, onEvent }: RunAgentParams) => {
      onEvent?.({
        type: 'status',
        payload: { status: 'phase_started', runId, phase: 'plan' },
      })
      onEvent?.({
        type: 'status',
        payload: { status: 'plan_ready', runId, phase: 'plan', summary: 'Ready', todos: [] },
      })
      onEvent?.({
        type: 'status',
        payload: { status: 'phase_transition', runId, from: 'plan', to: 'build' },
      })
      onEvent?.({
        type: 'status',
        payload: { status: 'phase_started', runId, phase: 'build' },
      })
      onEvent?.({
        type: 'status',
        payload: { status: 'phase_completed', runId, phase: 'build' },
      })

      return {
        output: 'build complete',
        provider: 'openai',
        model: 'gpt-5',
        modelSource: 'default',
        usage: { inputTokens: 8, outputTokens: 13, totalTokens: 21 },
        durationMs: 920,
      }
    })
  })

  it('persists two-phase lifecycle ordering from event record shape', async () => {
    const runId = 'run-lifecycle-001'
    const run = buildRun(runId)

    getRunMock.mockResolvedValue(run)
    getJobByRunIdMock.mockResolvedValue({ attempts: 0, maxAttempts: 3 })
    seedQueuedEvent()

    await import('../../worker/queue?queue-event-lifecycle-unit')
    expect(subscriptionHandler).not.toBeNull()

    await subscriptionHandler?.({ runId })

    const timeline = persistedEvents.map(timelineLabelFromEvent)
    const expectedTimeline = [
      'queued',
      'running',
      'phase_started(plan)',
      'plan_ready',
      'phase_transition',
      'phase_started(build)',
      'phase_completed(build)',
      'done',
    ]

    const filteredTimeline = timeline.filter((label) =>
      expectedTimeline.includes(label),
    )

    expect(filteredTimeline).toEqual(expectedTimeline)
    expect(persistedEvents.some((event) => event.type === 'done')).toBe(true)
    const ids = persistedEvents.map((event) => event.id)
    const seqs = persistedEvents.map((event) => event.seq)
    const expectedSequence = Array.from({ length: persistedEvents.length }, (_, index) => index + 1)

    expect(ids).toEqual(expectedSequence)
    expect(seqs).toEqual(expectedSequence)
    expect(insertEventWithNextSeqMock).toHaveBeenCalled()
    expect(updateRunStatusMock).toHaveBeenCalledWith(runId, 'running')
    expect(setJobStatusMock).toHaveBeenCalledWith(runId, 'succeeded')
    expect(completeRunMock).toHaveBeenCalledTimes(1)
    expect(commitRunToGitMock).toHaveBeenCalledWith({
      runId,
      workspaceBackend: 'host',
    })
  })
})
