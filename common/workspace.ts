import fs from 'node:fs'
import path from 'node:path'

export function parseByteLimit(raw: string | undefined, fallback: number) {
  const n = raw ? Number(raw) : fallback
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback
}

export function resolveWorkspaceRoot() {
  const configured = process.env.WORKSPACE_ROOT
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured)
  }

  try {
    const workspace = '/workspace'
    if (fs.existsSync(workspace) && fs.statSync(workspace).isDirectory()) return workspace
  } catch {
    // ignore
  }

  return process.cwd()
}

export function toPosixRelPath(p: string) {
  return p.split(path.sep).join('/')
}
