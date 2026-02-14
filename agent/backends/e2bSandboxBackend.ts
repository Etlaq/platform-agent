import path from 'node:path'
import type { Sandbox } from '@e2b/code-interpreter'
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

interface E2BSandboxBackendOptions {
  rootDir: string
}

function toPosix(p: string) {
  return p.replace(/\\/g, '/')
}

function toVirtualPath(p: string) {
  const normalized = toPosix(p)
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

export class E2BSandboxBackend implements BackendProtocol {
  private rootDir: string
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()

  constructor(private sandbox: Sandbox, options: E2BSandboxBackendOptions) {
    this.rootDir = options.rootDir
  }

  private toSandboxPath(virtualPath: string) {
    const cleaned = toPosix(virtualPath)
    const stripped = cleaned.replace(/^\/+/, '')
    return path.posix.join(this.rootDir, stripped)
  }

  private shellQuote(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }

  private async run(cmd: string, opts?: { cwd?: string }) {
    const commands = (this.sandbox as unknown as {
      commands: {
        run: (cmd: string, opts?: Record<string, unknown>) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>
      }
    }).commands
    try {
      return await commands.run(cmd, { cwd: opts?.cwd ?? this.rootDir })
    } catch (err) {
      // e2b throws on non-zero exits; recover so callers can choose how to handle it.
      const result = (err as any)?.result
      if (result && typeof result.exitCode === 'number') {
        return result as { exitCode: number; stdout?: string; stderr?: string }
      }
      throw err
    }
  }

  private async runOk(cmd: string, opts?: { cwd?: string }) {
    const result = await this.run(cmd, opts)
    if (result.exitCode !== 0) {
      const err = result.stderr ? `: ${result.stderr}` : ''
      throw new Error(`Sandbox command failed (${cmd})${err}`)
    }
    return result.stdout ?? ''
  }

  private async runAllowFailure(cmd: string, opts?: { cwd?: string }) {
    const result = await this.run(cmd, opts)
    return result.stdout ?? ''
  }

  async lsInfo(virtualPath = '/'): Promise<FileInfo[]> {
    const sandboxPath = this.toSandboxPath(virtualPath)
    const dir = this.shellQuote(sandboxPath)
    const cmd = `if [ -d ${dir} ]; then ls -a -p ${dir}; fi`
    const output = await this.runAllowFailure(cmd)
    const entries = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line !== '.' && line !== '..')

    const result: FileInfo[] = entries.map((entry) => {
      const isDir = entry.endsWith('/')
      const name = isDir ? entry.slice(0, -1) : entry
      const joined = path.posix.join(virtualPath, name)
      return {
        path: isDir ? `${joined}/` : joined,
        is_dir: isDir,
        size: 0,
        modified_at: '',
      }
    })

    result.sort((a, b) => a.path.localeCompare(b.path))
    return result
  }

  async read(virtualPath: string, offset = 0, limit = 2000): Promise<string> {
    const sandboxPath = this.toSandboxPath(virtualPath)
    const file = this.shellQuote(sandboxPath)
    const start = offset + 1
    const end = offset + limit
    const cmd = `if [ -f ${file} ]; then awk 'NR>=${start} && NR<=${end} {print NR \": \" $0}' ${file}; else echo '__ENOENT__'; fi`
    const output = await this.runAllowFailure(cmd)
    if (output.trim().startsWith('__ENOENT__')) {
      return `Error: File '${virtualPath}' not found`
    }
    return output.trimEnd()
  }

  async readRaw(virtualPath: string): Promise<FileData> {
    const sandboxPath = this.toSandboxPath(virtualPath)
    const file = this.shellQuote(sandboxPath)
    const out = await this.runAllowFailure(`if [ -f ${file} ]; then cat ${file}; else echo '__ENOENT__'; fi`)
    if (out.trim().startsWith('__ENOENT__')) {
      throw new Error(`File '${virtualPath}' not found`)
    }
    const now = new Date().toISOString()
    return {
      content: out.replace(/\r\n/g, '\n').split('\n'),
      created_at: now,
      modified_at: now,
    }
  }

  async write(virtualPath: string, content: string): Promise<WriteResult> {
    const sandboxPath = this.toSandboxPath(virtualPath)
    const file = this.shellQuote(sandboxPath)
    const dir = this.shellQuote(path.posix.dirname(sandboxPath))

    const exists = await this.runAllowFailure(`if [ -f ${file} ]; then echo 'yes'; fi`)
    if (exists.trim() === 'yes') {
      return { error: `Cannot write to ${virtualPath} because it already exists. Read and then make an edit, or write to a new path.` }
    }

    const payload = Buffer.from(content, 'utf8').toString('base64')
    const cmd = `mkdir -p ${dir} && printf '%s' '${payload}' | base64 -d > ${file}`
    await this.runOk(cmd)
    return { path: toVirtualPath(virtualPath), filesUpdate: null }
  }

  async edit(virtualPath: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    if (!oldString) {
      return { error: 'Error: oldString must not be empty.' }
    }

    const sandboxPath = this.toSandboxPath(virtualPath)
    const file = this.shellQuote(sandboxPath)
    const content = await this.runAllowFailure(`if [ -f ${file} ]; then cat ${file}; else echo '__ENOENT__'; fi`)
    if (content.trim().startsWith('__ENOENT__')) {
      return { error: `Error: File '${virtualPath}' not found` }
    }

    let occurrences = 0
    let idx = content.indexOf(oldString)
    while (idx !== -1) {
      occurrences += 1
      idx = content.indexOf(oldString, idx + oldString.length)
    }

    if (occurrences === 0) {
      return { error: `Error: '${oldString}' not found in ${virtualPath}` }
    }

    if (!replaceAll && occurrences > 1) {
      return {
        error:
          `Error: '${oldString}' occurs ${occurrences} times in ${virtualPath}. ` +
          'Pass replaceAll=true to replace all occurrences.',
      }
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    const payload = Buffer.from(updated, 'utf8').toString('base64')
    await this.runOk(`printf '%s' '${payload}' | base64 -d > ${file}`)
    return { path: toVirtualPath(virtualPath), occurrences, filesUpdate: null }
  }

  async globInfo(pattern: string, virtualPath = '/'): Promise<FileInfo[]> {
    const sandboxPath = this.toSandboxPath(virtualPath)
    const relPattern = pattern.replace(/^\/+/, '')
    const pathMatcher = this.shellQuote(`./${relPattern}`)
    const cmd = `cd ${this.shellQuote(sandboxPath)} && find . -path ${pathMatcher} -print0 | while IFS= read -r -d '' p; do if [ -d \"$p\" ]; then t=dir; else t=file; fi; echo \"$p|$t\"; done`
    const output = await this.runAllowFailure(cmd)
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const result: FileInfo[] = lines.map((line) => {
      const [rawPath, type] = line.split('|')
      const rel = rawPath.replace(/^\.\/?/, '')
      const joined = path.posix.join(virtualPath, rel)
      const virtual = toVirtualPath(joined)
      const isDir = type === 'dir'
      return {
        path: isDir && !virtual.endsWith('/') ? `${virtual}/` : virtual,
        is_dir: isDir,
        size: 0,
        modified_at: '',
      }
    })

    result.sort((a, b) => a.path.localeCompare(b.path))
    return result
  }

  async grepRaw(pattern: string, virtualPath = '/', globPattern?: string): Promise<GrepMatch[] | string> {
    const sandboxPath = this.toSandboxPath(virtualPath)
    const regex = this.shellQuote(pattern)
    const relGlob = (globPattern ?? '').replace(/^\/+/, '')
    let cmd = ''
    if (relGlob) {
      const globMatcher = this.shellQuote(`./${relGlob}`)
      cmd = `cd ${this.shellQuote(sandboxPath)} && find . -path ${globMatcher} -type f -print0 | xargs -0 grep -n -E ${regex} || true`
    } else {
      cmd = `cd ${this.shellQuote(sandboxPath)} && grep -R -n -E ${regex} . || true`
    }

    const output = await this.runAllowFailure(cmd)
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const results: GrepMatch[] = []
    for (const line of lines) {
      const first = line.indexOf(':')
      const second = line.indexOf(':', first + 1)
      if (first === -1 || second === -1) continue
      const rawPath = line.slice(0, first)
      const lineNum = Number(line.slice(first + 1, second))
      const text = line.slice(second + 1)
      const rel = rawPath.replace(/^\.\/?/, '')
      results.push({
        path: toVirtualPath(path.posix.join(virtualPath, rel)),
        line: Number.isFinite(lineNum) ? lineNum : 0,
        text,
      })
    }

    return results
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const out: FileDownloadResponse[] = []
    for (const p of paths) {
      try {
        const raw = await this.readRaw(p)
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
    const responses: FileUploadResponse[] = []
    for (const [virtualPath, bytes] of files) {
      try {
        const sandboxPath = this.toSandboxPath(virtualPath)
        const file = this.shellQuote(sandboxPath)
        const dir = this.shellQuote(path.posix.dirname(sandboxPath))
        const payload = Buffer.from(bytes).toString('base64')
        const cmd = `mkdir -p ${dir} && printf '%s' '${payload}' | base64 -d > ${file}`
        await this.runOk(cmd)
        responses.push({ path: toVirtualPath(virtualPath), error: null })
      } catch {
        responses.push({ path: toVirtualPath(virtualPath), error: 'permission_denied' })
      }
    }
    return responses as any
  }
}
