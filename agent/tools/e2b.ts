import { Sandbox } from '@e2b/code-interpreter'
import { tool } from 'langchain'
import { e2bToolSchema, type E2BToolInput } from './e2bSchema'

export interface E2BToolOptions {
  template: string
  sandboxTimeoutMs?: number
  sandbox?: Sandbox
  ownsSandbox?: boolean
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface E2BToolHandle {
  tool: any
  close: () => Promise<void>
}

async function createContext(
  sandbox: Sandbox,
  params: E2BToolInput,
  sandboxTimeoutMs?: number
): Promise<unknown | undefined> {
  const wantsContext = Boolean(params.language || params.timeoutMs || sandboxTimeoutMs)
  const createCodeContext = (sandbox as unknown as {
    createCodeContext?: (opts: Record<string, unknown>) => Promise<unknown>
  }).createCodeContext

  if (!wantsContext || !createCodeContext) return undefined

  return createCodeContext.call(sandbox, {
    language: params.language,
    requestTimeoutMs: params.timeoutMs ?? sandboxTimeoutMs,
  })
}

export function createE2BTool(options: E2BToolOptions): E2BToolHandle {
  let sandbox: Sandbox | null = options.sandbox ?? null
  const ownsSandbox = options.ownsSandbox ?? !options.sandbox

  const getSandbox = async () => {
    if (sandbox) return sandbox
    sandbox = await Sandbox.create(
      options.template,
      options.sandboxTimeoutMs ? { timeoutMs: options.sandboxTimeoutMs } : undefined
    )
    return sandbox
  }

  const execTool = tool(
    async (params: E2BToolInput) => {
      const instance = await getSandbox()
      const context = await createContext(instance, params, options.sandboxTimeoutMs)

      const runCode = (instance as unknown as {
        runCode: (
          code: string,
          opts?: {
            language?: string
            context?: unknown
            onStdout?: (chunk: string) => void
            onStderr?: (chunk: string) => void
          }
        ) => Promise<Record<string, unknown>>
      }).runCode

      const execution = await runCode.call(instance, params.code, {
        language: params.language,
        context,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      })

      const text =
        (execution as { text?: string }).text ||
        (execution as { stdout?: string }).stdout ||
        ''

      return {
        text,
        stdout: (execution as { stdout?: string }).stdout ?? null,
        stderr: (execution as { stderr?: string }).stderr ?? null,
        results: (execution as { results?: unknown }).results ?? null,
      }
    },
    {
      name: 'sandbox_exec',
      description:
        'Execute code in an isolated E2B sandbox. Returns stdout/stderr and structured results when available.',
      schema: e2bToolSchema,
    }
  )

  const close = async () => {
    if (!sandbox || !ownsSandbox) return
    const closeFn = (sandbox as unknown as { close?: () => Promise<void> }).close
    const killFn = (sandbox as unknown as { kill?: () => Promise<void> }).kill
    if (closeFn) {
      await closeFn.call(sandbox)
    } else if (killFn) {
      await killFn.call(sandbox)
    }
  }

  return { tool: execTool as any, close }
}
