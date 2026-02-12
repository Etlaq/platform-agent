import { tool } from 'langchain'
import { detectNextBun } from '../project/detectNextBun'
import { projectActionHandlers } from './projectActions/handlers'
import { strictSchema, toolSchema } from './projectActions/schemas'
import type { CreateProjectActionsToolParams } from './projectActions/types'

export function createProjectActionsTool(params: CreateProjectActionsToolParams) {
  return tool(
    async (input) => {
      const parsed = strictSchema.parse(input)
      const detection = detectNextBun(params.workspaceRoot)

      const requireNextBun = () => {
        if (!detection.isNext) throw new Error('Workspace is not a Next.js project (missing next dependency).')
        if (!detection.isBun) throw new Error('Workspace is not Bun-managed (missing bun.lock[b] or packageManager bun@...).')
      }

      const handler = projectActionHandlers[parsed.action]
      if (!handler) {
        return { error: 'Unhandled action' }
      }

      if (handler.requiresNextBun) {
        requireNextBun()
      }

      return handler.run({ params, detection }, parsed)
    },
    {
      name: 'project_actions',
      description:
        'High-level, policy-guarded actions for Bun + Next.js projects (no arbitrary shell). Use this for dependency installs, scaffolding auth/db/cron, env validation, and rollbacks.',
      schema: toolSchema,
    }
  )
}
