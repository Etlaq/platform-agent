import type { NextBunDetection } from '../../project/detectNextBun'
import type { RollbackManager } from '../../rollback/rollbackManager'
import type { ProjectAction, ProjectActionInput } from './schemas'

export interface CreateProjectActionsToolParams {
  workspaceRoot: string
  rollback: RollbackManager
  allowHostInstalls: boolean
}

export interface ProjectActionContext {
  params: CreateProjectActionsToolParams
  detection: NextBunDetection
}

export interface ProjectActionHandler {
  requiresNextBun?: boolean
  run: (context: ProjectActionContext, input: ProjectActionInput) => Promise<unknown> | unknown
}

export type ProjectActionHandlerMap = Record<ProjectAction, ProjectActionHandler>
