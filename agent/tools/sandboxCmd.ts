import { tool } from 'langchain'
import { z } from 'zod'
import type { Sandbox } from '@e2b/code-interpreter'

const sandboxCmdSchema = z.object({
  cmd: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

function isAllowedCommand(cmd: string) {
  const trimmed = cmd.trim()
  return (
    trimmed.startsWith('bun ') ||
    trimmed.startsWith('bunx ') ||
    trimmed.startsWith('node ') ||
    trimmed.startsWith('npm ') ||
    trimmed.startsWith('pnpm ')
  )
}

export function createSandboxCmdTool(params: {
  sandbox: Sandbox
  defaultCwd: string
}) {
  return tool(
    async (input) => {
      const parsed = sandboxCmdSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, error: 'Invalid input.', issues: parsed.error.issues }
      }

      if (!isAllowedCommand(parsed.data.cmd)) {
        return {
          ok: false,
          error:
            'Command denied by policy. Allowed prefixes: bun, bunx, node, npm, pnpm.',
        }
      }

      try {
        const res = await params.sandbox.commands.run(parsed.data.cmd, {
          cwd: parsed.data.cwd ?? params.defaultCwd,
          timeoutMs: parsed.data.timeoutMs,
        })

        return {
          ok: true,
          exitCode: (res as any).exitCode ?? 0,
          stdout: (res as any).stdout ?? '',
          stderr: (res as any).stderr ?? '',
        }
      } catch (err) {
        const result = (err as any)?.result
        if (result && typeof result.exitCode === 'number') {
          return {
            ok: false,
            exitCode: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            error: result.error ?? (err instanceof Error ? err.message : String(err)),
          }
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    {
      name: 'sandbox_cmd',
      description:
        'Run a limited set of package/dev commands inside the E2B sandbox (bun/bunx/node/npm/pnpm).',
      schema: sandboxCmdSchema as any,
    }
  )
}
