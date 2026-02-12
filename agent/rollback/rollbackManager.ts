import fs from 'node:fs'
import path from 'node:path'

export type RollbackEntry =
  | {
      relPath: string
      kind: 'modify'
      backupFile: string
    }
  | {
      relPath: string
      kind: 'create'
    }

export interface RollbackManifest {
  runId: string
  createdAt: string
  workspaceRoot: string
  entries: RollbackEntry[]
}

function validateRunId(runId: string) {
  const trimmed = String(runId ?? '').trim()
  if (!trimmed) throw new Error('Invalid runId')
  if (trimmed.length > 128) throw new Error('Invalid runId')
  // Only block path separators and NUL; this prevents traversal via path.join().
  if (/[\/\\\0]/.test(trimmed)) throw new Error('Invalid runId')
  return trimmed
}

function safeRelPath(input: string) {
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '')
  // Disallow path traversal (segment-based; allow names containing ".." like "[...nextauth]").
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || normalized === '.') {
    throw new Error(`Invalid path: ${input}`)
  }
  for (const seg of segments) {
    if (seg === '..') throw new Error(`Invalid path: ${input}`)
  }
  return normalized
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export class RollbackManager {
  private runDir: string
  private filesDir: string
  private manifestPath: string
  private manifest: RollbackManifest
  private recorded = new Set<string>()

  constructor(params: { runId: string; rollbackRoot: string; workspaceRoot: string }) {
    this.runDir = path.join(params.rollbackRoot, params.runId)
    this.filesDir = path.join(this.runDir, 'files')
    this.manifestPath = path.join(this.runDir, 'manifest.json')
    this.manifest = {
      runId: params.runId,
      createdAt: new Date().toISOString(),
      workspaceRoot: params.workspaceRoot,
      entries: [],
    }

    fs.mkdirSync(this.filesDir, { recursive: true })
    this.flush()
  }

  static manifestPath(params: { runId: string; rollbackRoot: string }) {
    const runId = validateRunId(params.runId)
    return path.join(params.rollbackRoot, runId, 'manifest.json')
  }

  getManifest() {
    return this.manifest
  }

  getTouchedFiles() {
    return this.manifest.entries.map((e) => e.relPath)
  }

  private flush() {
    fs.mkdirSync(this.runDir, { recursive: true })
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8')
  }

  recordBeforeChange(absPath: string, workspaceRoot: string) {
    const relPath = safeRelPath(path.relative(workspaceRoot, absPath))
    if (this.recorded.has(relPath)) return
    this.recorded.add(relPath)

    if (!fs.existsSync(absPath)) {
      this.manifest.entries.push({ relPath, kind: 'create' })
      this.flush()
      return
    }

    const backupName = `${base64UrlEncode(relPath)}.bak`
    const backupFile = path.join(this.filesDir, backupName)
    const buf = fs.readFileSync(absPath)
    fs.writeFileSync(backupFile, buf)
    this.manifest.entries.push({ relPath, kind: 'modify', backupFile: path.posix.join('files', backupName) })
    this.flush()
  }

  restore() {
    for (const entry of this.manifest.entries) {
      const absPath = path.join(this.manifest.workspaceRoot, entry.relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      if (entry.kind === 'create') {
        if (fs.existsSync(absPath)) {
          fs.rmSync(absPath, { force: true })
        }
        continue
      }

      const backupAbs = path.join(this.runDir, entry.backupFile)
      const buf = fs.readFileSync(backupAbs)
      fs.writeFileSync(absPath, buf)
    }

    return { restored: this.getTouchedFiles() }
  }

  static restoreFromDisk(params: { runId: string; rollbackRoot: string }) {
    validateRunId(params.runId)
    const manifestPath = RollbackManager.manifestPath(params)
    const raw = fs.readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(raw) as RollbackManifest
    const manager = Object.create(RollbackManager.prototype) as RollbackManager
    manager.runDir = path.join(params.rollbackRoot, params.runId)
    manager.filesDir = path.join(manager.runDir, 'files')
    manager.manifestPath = manifestPath
    manager.manifest = manifest
    manager.recorded = new Set(manifest.entries.map((e) => e.relPath))
    return manager.restore()
  }
}
