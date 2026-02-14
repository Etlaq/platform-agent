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

function isBackupRelPath(relPath: string) {
  return relPath.startsWith('files/')
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

function isInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const rootDrive = path.parse(resolvedRoot).root
  if (resolvedRoot === rootDrive) {
    return true
  }
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  )
}

function parseRollbackManifest(raw: string, expectedRunId: string): RollbackManifest {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid rollback manifest')
  }

  const payload = parsed as Record<string, unknown>
  const runId = String(payload.runId ?? '').trim()
  const createdAt = String(payload.createdAt ?? new Date().toISOString())
  const workspaceRoot = String(payload.workspaceRoot ?? '').trim()
  const rawEntries = payload.entries

  if (!runId || runId !== expectedRunId) throw new Error('Invalid rollback manifest')
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) throw new Error('Invalid rollback manifest')
  if (!Array.isArray(rawEntries)) throw new Error('Invalid rollback manifest')

  const entries: RollbackEntry[] = []
  for (const rawEntry of rawEntries) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new Error('Invalid rollback manifest entry')
    }
    const item = rawEntry as Record<string, unknown>
    const kind = String(item.kind ?? '')
    const relPath = safeRelPath(String(item.relPath ?? ''))

    if (kind === 'create') {
      entries.push({ relPath, kind: 'create' })
      continue
    }

    if (kind === 'modify') {
      const backupFile = String(item.backupFile ?? '').trim()
      if (!backupFile) throw new Error('Invalid rollback manifest entry')
      const backupRel = safeRelPath(backupFile)
      if (!isBackupRelPath(backupRel)) throw new Error('Invalid rollback manifest entry')
      entries.push({ relPath, kind: 'modify', backupFile })
      continue
    }

    throw new Error('Invalid rollback manifest entry')
  }

  return { runId, createdAt, workspaceRoot, entries }
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

  static parseManifest(raw: string, runId: string) {
    return parseRollbackManifest(raw, validateRunId(runId))
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
      const relPath = safeRelPath(entry.relPath)
      const absPath = path.join(this.manifest.workspaceRoot, relPath)
      if (!isInside(this.manifest.workspaceRoot, absPath)) {
        throw new Error(`Invalid rollback path: ${entry.relPath}`)
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      if (entry.kind === 'create') {
        if (fs.existsSync(absPath)) {
          fs.rmSync(absPath, { force: true })
        }
        continue
      }

      const backupRel = safeRelPath(entry.backupFile)
      if (!isBackupRelPath(backupRel)) {
        throw new Error(`Invalid rollback backup path: ${entry.backupFile}`)
      }
      const backupAbs = path.join(this.runDir, backupRel)
      if (!isInside(this.filesDir, backupAbs)) {
        throw new Error(`Invalid rollback backup path: ${entry.backupFile}`)
      }
      const buf = fs.readFileSync(backupAbs)
      fs.writeFileSync(absPath, buf)
    }

    return { restored: this.getTouchedFiles() }
  }

  static restoreFromDisk(params: { runId: string; rollbackRoot: string }) {
    const runId = validateRunId(params.runId)
    const manifestPath = RollbackManager.manifestPath(params)
    const raw = fs.readFileSync(manifestPath, 'utf8')
    const manifest = RollbackManager.parseManifest(raw, runId)
    const manager = Object.create(RollbackManager.prototype) as RollbackManager
    manager.runDir = path.join(params.rollbackRoot, params.runId)
    manager.filesDir = path.join(manager.runDir, 'files')
    manager.manifestPath = manifestPath
    manager.manifest = manifest
    manager.recorded = new Set(manifest.entries.map((e) => e.relPath))
    return manager.restore()
  }
}
