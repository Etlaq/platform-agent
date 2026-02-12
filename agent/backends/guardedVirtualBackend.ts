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
import { ensureAllowedPath, isAllowedWritePath } from './pathPolicy'

export class GuardedVirtualBackend implements BackendProtocol {
  public readonly touchedFiles = new Set<string>()
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()

  constructor(private inner: BackendProtocol) {}

  async lsInfo(dirPath: string): Promise<FileInfo[]> {
    try {
      return await this.inner.lsInfo(ensureAllowedPath(dirPath))
    } catch {
      // Denied or missing dirs should not crash the agent loop.
      return []
    }
  }

  async read(filePath: string, offset?: number, limit?: number): Promise<string> {
    try {
      return await this.inner.read(ensureAllowedPath(filePath), offset, limit)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error: ${msg}`
    }
  }

  async readRaw(filePath: string): Promise<FileData> {
    // readRaw is used by internal middleware (memories). For denied paths, throw.
    return this.inner.readRaw(ensureAllowedPath(filePath))
  }

  async grepRaw(pattern: string, p?: string | null, glob?: string | null): Promise<GrepMatch[] | string> {
    let allowed = '/'
    try {
      allowed = ensureAllowedPath(p ?? '/')
    } catch {
      return []
    }

    const res = await this.inner.grepRaw(pattern, allowed, glob ?? undefined)
    if (typeof res === 'string') return res

    const filtered: GrepMatch[] = []
    for (const m of res) {
      try {
        ensureAllowedPath(m.path)
        filtered.push(m)
      } catch {
        // drop
      }
    }
    return filtered
  }

  async globInfo(pattern: string, p?: string): Promise<FileInfo[]> {
    try {
      const allowed = p ? ensureAllowedPath(p) : '/'
      return await this.inner.globInfo(pattern, allowed)
    } catch {
      return []
    }
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
    const res = await this.inner.write(allowedPath, content)
    if (!res.error) this.touchedFiles.add(allowedPath.replace(/^\/+/, ''))
    return res
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
    const res = await this.inner.edit(allowedPath, oldString, newString, replaceAll)
    if (!res.error) this.touchedFiles.add(allowedPath.replace(/^\/+/, ''))
    return res
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const out: FileDownloadResponse[] = []
    for (const p of paths) {
      try {
        const allowed = ensureAllowedPath(p)

        // Prefer inner backend's bulk download when available.
        const innerAny = this.inner as any
        if (typeof innerAny.downloadFiles === 'function') {
          const res: FileDownloadResponse[] = await innerAny.downloadFiles([allowed])
          const first = res[0]
          out.push({
            path: p,
            content: first?.content ?? null,
            error: first?.error ?? null,
          })
          continue
        }

        const raw = await this.inner.readRaw(allowed)
        const text = (raw.content ?? []).join('\n')
        out.push({ path: p, content: this.encoder.encode(text), error: null })
      } catch {
        out.push({ path: p, content: null, error: 'file_not_found' })
      }
    }
    return out
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>
  ): Promise<FileUploadResponse[] & { filesUpdate?: Record<string, FileData> }> {
    const innerAny = this.inner as any

    // Pre-validate paths and policy before delegating to the inner backend.
    const allowedUploads: Array<[string, Uint8Array]> = []
    const denied: FileUploadResponse[] = []
    for (const [p, bytes] of files) {
      let allowed = ''
      try {
        allowed = ensureAllowedPath(p)
      } catch {
        denied.push({ path: p, error: 'invalid_path' })
        continue
      }
      if (!isAllowedWritePath(allowed)) {
        denied.push({ path: p, error: 'permission_denied' })
        continue
      }
      allowedUploads.push([allowed, bytes])
    }

    if (typeof innerAny.uploadFiles === 'function') {
      const res: FileUploadResponse[] = await innerAny.uploadFiles(allowedUploads)
      for (const r of res) {
        if (!r?.error) this.touchedFiles.add(String(r.path ?? '').replace(/^\/+/, ''))
      }
      // Map delegated responses back to requested paths when we can.
      // If the inner returns allowed paths, that's still fine for DeepAgents.
      return [...denied, ...res] as any
    }

    // Fallback: best-effort overwrite using edit/ write.
    const responses: FileUploadResponse[] = [...denied]
    for (const [allowedPath, bytes] of allowedUploads) {
      try {
        const content = this.decoder.decode(bytes)
        let existing = ''
        try {
          const raw = await this.inner.readRaw(allowedPath)
          existing = (raw.content ?? []).join('\n')
        } catch {
          existing = ''
        }

        if (!existing) {
          const wr = await this.inner.write(allowedPath, content)
          if (wr.error) {
            responses.push({ path: allowedPath, error: 'permission_denied' })
          } else {
            this.touchedFiles.add(allowedPath.replace(/^\/+/, ''))
            responses.push({ path: allowedPath, error: null })
          }
          continue
        }

        const ed = await this.inner.edit(allowedPath, existing, content, false)
        if (ed.error) {
          responses.push({ path: allowedPath, error: 'permission_denied' })
        } else {
          this.touchedFiles.add(allowedPath.replace(/^\/+/, ''))
          responses.push({ path: allowedPath, error: null })
        }
      } catch {
        responses.push({ path: allowedPath, error: 'permission_denied' })
      }
    }

    return responses as any
  }
}
