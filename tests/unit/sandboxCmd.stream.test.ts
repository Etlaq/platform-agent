import { beforeEach, describe, expect, it, vi } from 'bun:test'

const runSandboxCommandWithTimeoutMock = vi.fn(async (
  _sandbox: unknown,
  cmd: string,
  opts?: {
    onStdout?: (data: string) => void | Promise<void>
    onStderr?: (data: string) => void | Promise<void>
  },
) => {
  // cleanupStaleNextBuild calls this with a pkill command — return early for cleanup calls
  if (cmd.includes('pkill')) {
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  await opts?.onStdout?.('stdout chunk')
  await opts?.onStderr?.('stderr chunk')
  return {
    exitCode: 0,
    stdout: 'stdout chunk',
    stderr: 'stderr chunk',
  }
})

vi.mock('langchain', () => ({
  tool: (
    handler: (input: unknown) => Promise<unknown>,
    meta: { name: string; description: string; schema: unknown },
  ) => ({
    ...meta,
    invoke: handler,
  }),
}))

vi.mock('../../common/e2bSandbox', () => ({
  runSandboxCommandWithTimeout: runSandboxCommandWithTimeoutMock,
}))

let moduleSeq = 0

async function loadSandboxCmdModule() {
  moduleSeq += 1
  return import(`../../agent/tools/sandboxCmd?stream-test-${moduleSeq}`)
}

describe('sandbox_cmd streaming callbacks', () => {
  beforeEach(() => {
    runSandboxCommandWithTimeoutMock.mockClear()
  })

  it('forwards stdout/stderr chunks to callbacks while command is running', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const { createSandboxCmdTool } = await loadSandboxCmdModule()
    const tool = createSandboxCmdTool({
      sandbox: {} as any,
      defaultCwd: '/home/user',
      onStdout: ({ chunk }) => {
        stdout.push(chunk)
      },
      onStderr: ({ chunk }) => {
        stderr.push(chunk)
      },
    }) as unknown as {
      invoke: (input: unknown) => Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }>
    }

    const result = await tool.invoke({
      cmd: 'bun run build',
    })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(stdout).toEqual(['stdout chunk'])
    expect(stderr).toEqual(['stderr chunk'])
  })
})

