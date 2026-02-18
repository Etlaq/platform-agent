import type { BackendProtocol } from 'deepagents'
import type { FileOpPayload } from '../events'

export interface ObservableBackendOptions {
  onFileOp: (payload: FileOpPayload) => void
  getPhase: () => 'plan' | 'build'
}

/**
 * Wraps any BackendProtocol and emits `file_op` events after successful operations.
 *
 * - Does NOT emit events for `readRaw` (used internally by DeepAgents memory middleware).
 * - Does NOT include file contents in events — only path + metadata.
 * - Events are emitted **after** the inner operation succeeds (no events on failure).
 */
export class ObservableBackend implements BackendProtocol {
  constructor(
    private inner: BackendProtocol,
    private opts: ObservableBackendOptions,
  ) {}

  async lsInfo(path: string) {
    const result = await this.inner.lsInfo(path)
    this.opts.onFileOp({
      op: 'ls',
      path,
      phase: this.opts.getPhase(),
      entryCount: Array.isArray(result) ? result.length : undefined,
    })
    return result
  }

  async read(filePath: string, offset?: number, limit?: number) {
    const result = await this.inner.read(filePath, offset, limit)
    this.opts.onFileOp({
      op: 'read',
      path: filePath,
      phase: this.opts.getPhase(),
    })
    return result
  }

  async readRaw(filePath: string) {
    // Pass-through: no events for internal reads
    return this.inner.readRaw(filePath)
  }

  async write(filePath: string, content: string) {
    const result = await this.inner.write(filePath, content)
    if (!result.error) {
      this.opts.onFileOp({
        op: 'write',
        path: filePath,
        phase: this.opts.getPhase(),
        sizeChars: content.length,
      })
    }
    return result
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean) {
    const result = await this.inner.edit(filePath, oldString, newString, replaceAll)
    if (!result.error) {
      this.opts.onFileOp({
        op: 'edit',
        path: filePath,
        phase: this.opts.getPhase(),
      })
    }
    return result
  }

  async grepRaw(pattern: string, path?: string | null, glob?: string | null) {
    const result = await this.inner.grepRaw(pattern, path, glob)
    if (typeof result !== 'string') {
      this.opts.onFileOp({
        op: 'grep',
        path: path ?? '/',
        phase: this.opts.getPhase(),
        pattern,
        matchCount: result.length,
      })
    }
    return result
  }

  async globInfo(pattern: string, path?: string) {
    const result = await this.inner.globInfo(pattern, path)
    this.opts.onFileOp({
      op: 'glob',
      path: path ?? '/',
      phase: this.opts.getPhase(),
      pattern,
      matchCount: result.length,
    })
    return result
  }

  async downloadFiles(paths: string[]) {
    if (this.inner.downloadFiles) {
      return this.inner.downloadFiles(paths)
    }
    return paths.map((p) => ({ path: p, content: null, error: 'file_not_found' as const }))
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    if (this.inner.uploadFiles) {
      return this.inner.uploadFiles(files)
    }
    return files.map(([p]) => ({ path: p, error: 'permission_denied' as const }))
  }
}
