import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { FilesystemBackend } from 'deepagents'
import type {
  BackendProtocol,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GrepMatch,
  WriteResult,
} from 'deepagents'
import { RollbackManager } from '../rollback/rollbackManager'
import { ensureAllowedPath, isAllowedWritePath, normalizeVirtualPath } from './pathPolicy'

export class GuardedFilesystemBackend implements BackendProtocol {
  private backend: FilesystemBackend
  private workspaceRoot: string
  private rollback: RollbackManager
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()

  constructor(params: { rootDir: string; rollback: RollbackManager }) {
    this.workspaceRoot = params.rootDir
    this.rollback = params.rollback
    this.backend = new FilesystemBackend({ rootDir: params.rootDir, virtualMode: true })
  }

  private resolveAbs(virtualPath: string) {
    const rel = normalizeVirtualPath(virtualPath)
    const abs = path.resolve(this.workspaceRoot, rel)
    // Ensure inside root.
    const root = path.resolve(this.workspaceRoot)
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      throw new Error('Path escapes workspace root')
    }
    return abs
  }

  async lsInfo(dirPath: string): Promise<FileInfo[]> {
    return this.backend.lsInfo(ensureAllowedPath(dirPath))
  }

  async read(filePath: string, offset?: number, limit?: number): Promise<string> {
    return this.backend.read(ensureAllowedPath(filePath), offset, limit)
  }

  async readRaw(filePath: string): Promise<FileData> {
    return this.backend.readRaw(ensureAllowedPath(filePath))
  }

  async grepRaw(pattern: string, p?: string | null, glob?: string | null): Promise<GrepMatch[] | string> {
    // Never allow grepping secrets out of denied files like ".env".
    const allowed = ensureAllowedPath(p ?? '/')
    const res = await this.backend.grepRaw(pattern, allowed, glob ?? undefined)
    if (typeof res === 'string') return res

    const filtered: GrepMatch[] = []
    for (const m of res) {
      try {
        // Re-apply path policy to each match path.
        ensureAllowedPath(m.path)
        filtered.push(m)
      } catch {
        // drop
      }
    }
    return filtered
  }

  async globInfo(pattern: string, p?: string): Promise<FileInfo[]> {
    const allowed = p ? ensureAllowedPath(p) : '/'
    return this.backend.globInfo(pattern, allowed)
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    let allowedPath = ''
    try {
      allowedPath = ensureAllowedPath(filePath)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!isAllowedWritePath(allowedPath)) {
      return { error: `Write denied by policy: ${allowedPath}` }
    }
    const abs = this.resolveAbs(allowedPath)
    this.rollback.recordBeforeChange(abs, this.workspaceRoot)
    return this.backend.write(allowedPath, content)
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    let allowedPath = ''
    try {
      allowedPath = ensureAllowedPath(filePath)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    if (!isAllowedWritePath(allowedPath)) {
      return { error: `Edit denied by policy: ${allowedPath}` }
    }
    const abs = this.resolveAbs(allowedPath)
    if (fs.existsSync(abs)) {
      this.rollback.recordBeforeChange(abs, this.workspaceRoot)
    }
    return this.backend.edit(allowedPath, oldString, newString, replaceAll)
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const out: FileDownloadResponse[] = []
    for (const p of paths) {
      try {
        const allowed = ensureAllowedPath(p)
        const raw = await this.backend.readRaw(allowed)
        const text = (raw.content ?? []).join('\n')
        out.push({ path: p, content: this.encoder.encode(text), error: null })
      } catch {
        out.push({ path: p, content: null, error: 'file_not_found' })
      }
    }
    return out
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[] & { filesUpdate?: Record<string, FileData> }> {
    const responses: FileUploadResponse[] = []
    for (const [p, bytes] of files) {
      let allowedPath = ''
      try {
        allowedPath = ensureAllowedPath(p)
      } catch {
        responses.push({ path: p, error: 'invalid_path' })
        continue
      }

      if (!isAllowedWritePath(allowedPath)) {
        responses.push({ path: p, error: 'permission_denied' })
        continue
      }

      try {
        const abs = this.resolveAbs(allowedPath)
        // Record rollback snapshot for existing files.
        if (fs.existsSync(abs)) this.rollback.recordBeforeChange(abs, this.workspaceRoot)

        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await fsp.writeFile(abs, bytes)
        responses.push({ path: p, error: null })
      } catch {
        responses.push({ path: p, error: 'permission_denied' })
      }
    }
    return responses as any
  }
}
