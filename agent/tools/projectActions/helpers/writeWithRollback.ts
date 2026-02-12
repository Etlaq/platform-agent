import fs from 'node:fs'
import path from 'node:path'
import type { RollbackManager } from '../../../rollback/rollbackManager'
import { ensureDir } from './fileSystem'

export function writeFileWithRollback(params: {
  workspaceRoot: string
  rollback: RollbackManager
  relPath: string
  content: string
}) {
  const abs = path.join(params.workspaceRoot, params.relPath)
  params.rollback.recordBeforeChange(abs, params.workspaceRoot)
  ensureDir(path.dirname(abs))
  fs.writeFileSync(abs, params.content, 'utf8')
  return { path: params.relPath }
}
