import { beforeEach, describe, expect, it, vi } from 'bun:test'

const execMock = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => undefined)

class MockSQLDatabase {
  constructor(_name: string, _opts: { migrations: string }) {}

  exec(strings: TemplateStringsArray, ...values: unknown[]) {
    return execMock(strings, ...values)
  }

  query<T>() {
    async function* empty(): AsyncIterable<T> {
      return
    }
    return empty()
  }

  async queryRow<T>() {
    return null as T | null
  }
}

vi.mock('encore.dev/storage/sqldb', () => ({
  SQLDatabase: MockSQLDatabase,
}))

let moduleSeq = 0

async function loadDataDbModule() {
  moduleSeq += 1
  return import(`../../data/db?data-db-complete-run-${moduleSeq}`)
}

describe('data/db completeRun', () => {
  beforeEach(() => {
    execMock.mockClear()
  })

  it('persists resolved provider/model while keeping usage/duration writes', async () => {
    const { completeRun } = await loadDataDbModule()

    await completeRun('run-1', 'final output', {
      provider: 'openai',
      model: 'gpt-5',
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      durationMs: 420,
    })

    expect(execMock).toHaveBeenCalledTimes(1)
    const [strings, ...values] = execMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    const sql = strings.join(' ')

    expect(sql).toContain('provider = COALESCE(')
    expect(sql).toContain('model = COALESCE(')
    expect(values).toEqual(['final output', 'openai', 'gpt-5', 11, 7, 18, 420, 'run-1'])
  })

  it('stays backward-compatible when provider/model are omitted', async () => {
    const { completeRun } = await loadDataDbModule()

    await completeRun('run-2', 'legacy output', {
      usage: {
        inputTokens: 5,
        outputTokens: 4,
        totalTokens: 9,
      },
      durationMs: 210,
    })

    expect(execMock).toHaveBeenCalledTimes(1)
    const [, ...values] = execMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]]

    expect(values).toEqual(['legacy output', null, null, 5, 4, 9, 210, 'run-2'])
  })
})
