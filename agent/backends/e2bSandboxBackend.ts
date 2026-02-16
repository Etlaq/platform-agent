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
import { backoffDelayMs, isRetryableE2BError } from '../../common/e2bSandbox'

interface E2BSandboxBackendOptions {
  rootDir: string
}

const DENIED_DIR_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.bun',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.vscode',
  '.idea',
])

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const n = raw ? Number(raw) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function resolveE2BCmdRetryAttempts() {
  // Total attempts, including the first attempt.
  return parseBoundedInt(process.env.E2B_CMD_RETRY_ATTEMPTS, 3, 1, 20)
}

function resolveE2BCmdRetryBaseDelayMs() {
  return parseBoundedInt(process.env.E2B_CMD_RETRY_BASE_DELAY_MS, 250, 0, 60_000)
}

function resolveE2BCmdRetryMaxDelayMs() {
  return parseBoundedInt(process.env.E2B_CMD_RETRY_MAX_DELAY_MS, 2_000, 0, 5 * 60_000)
}

function shouldLogE2BCmdRetries() {
  return (process.env.E2B_CMD_RETRY_LOG || 'false').toLowerCase() === 'true'
}

function expandBracePattern(pattern: string) {
  const start = pattern.indexOf('{')
  if (start === -1) return [pattern]
  const end = pattern.indexOf('}', start + 1)
  if (end === -1) return [pattern]

  const before = pattern.slice(0, start)
  const after = pattern.slice(end + 1)
  const inner = pattern.slice(start + 1, end)
  const parts = inner.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return [pattern]

  // Only expand the first brace group to keep complexity predictable.
  return parts.map((part) => `${before}${part}${after}`)
}

function toPosix(p: string) {
  return p.replace(/\\/g, '/')
}

function toVirtualPath(p: string) {
  const normalized = toPosix(p)
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function isDeniedVirtualPath(virtualPath: string) {
  const cleaned = toPosix(virtualPath)
  const segments = cleaned.split('/').filter(Boolean)
  return segments.some((seg) => DENIED_DIR_SEGMENTS.has(seg))
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

  private findPruneDirsClause() {
    // Prune common large/irrelevant folders to avoid huge scans and slow tool calls.
    const names = [...DENIED_DIR_SEGMENTS].map((name) => `-name ${this.shellQuote(name)}`)
    return names.length ? `\\( ${names.join(' -o ')} \\) -prune -o` : ''
  }

  private async sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private async run(cmd: string, opts?: { cwd?: string }) {
    const commands = (this.sandbox as unknown as {
      commands: {
        run: (cmd: string, opts?: Record<string, unknown>) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>
      }
    }).commands

    const attempts = resolveE2BCmdRetryAttempts()
    const baseDelayMs = resolveE2BCmdRetryBaseDelayMs()
    const maxDelayMs = resolveE2BCmdRetryMaxDelayMs()
    const log = shouldLogE2BCmdRetries()

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await commands.run(cmd, { cwd: opts?.cwd ?? this.rootDir })
      } catch (err) {
        // e2b throws on non-zero exits; recover so callers can choose how to handle it.
        const result = (err as any)?.result
        if (result && typeof result.exitCode === 'number') {
          return result as { exitCode: number; stdout?: string; stderr?: string }
        }

        const finalAttempt = attempt >= attempts
        if (!finalAttempt && isRetryableE2BError(err)) {
          const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs)
          if (log) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(`[e2b] sandbox command failed (attempt ${attempt}/${attempts}): ${msg}`)
            if (delayMs > 0) console.warn(`[e2b] retrying in ${delayMs}ms`)
          }
          if (delayMs > 0) {
            await this.sleep(delayMs)
          }
          continue
        }

        throw err
      }
    }

    // Unreachable, but keeps TS happy.
    throw new Error('Sandbox command failed')
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
    if (isDeniedVirtualPath(virtualPath)) return []
    const sandboxPath = this.toSandboxPath(virtualPath)
    const dir = this.shellQuote(sandboxPath)
    const cmd = `if [ -d ${dir} ]; then ls -a -p ${dir}; fi`
    const output = await this.runAllowFailure(cmd)
    const entries = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line !== '.' && line !== '..')
      .filter((line) => {
        const name = line.endsWith('/') ? line.slice(0, -1) : line
        return !DENIED_DIR_SEGMENTS.has(name)
      })

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
    if (isDeniedVirtualPath(virtualPath)) {
      return `Error: Access to '${virtualPath}' is denied (protected directory).`
    }
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
    if (isDeniedVirtualPath(virtualPath)) {
      throw new Error(`Access to '${virtualPath}' is denied (protected directory).`)
    }
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
    if (isDeniedVirtualPath(virtualPath)) {
      return { error: `Cannot write to ${virtualPath} (protected directory).` }
    }
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
    if (isDeniedVirtualPath(virtualPath)) {
      return { error: `Error: Cannot edit ${virtualPath} (protected directory).` }
    }
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
    if (isDeniedVirtualPath(virtualPath)) return []
    const sandboxPath = this.toSandboxPath(virtualPath)
    const relPattern = pattern.replace(/^\/+/, '')
    const patterns = expandBracePattern(relPattern)

    const lines: string[] = []
    const prune = this.findPruneDirsClause()
    for (const ptn of patterns) {
      const pathMatcher = this.shellQuote(`./${ptn}`)
      const cmd = `cd ${this.shellQuote(sandboxPath)} && find . ${prune} -path ${pathMatcher} -print0 | while IFS= read -r -d '' p; do if [ -d \"$p\" ]; then t=dir; else t=file; fi; echo \"$p|$t\"; done`
      const output = await this.runAllowFailure(cmd)
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed) lines.push(trimmed)
      }
    }

    const seen = new Set<string>()
    const result: FileInfo[] = lines.flatMap((line) => {
      const [rawPath, type] = line.split('|')
      if (!rawPath) return []
      const rel = rawPath.replace(/^\.\/?/, '')
      const joined = path.posix.join(virtualPath, rel)
      const virtual = toVirtualPath(joined)
      const isDir = type === 'dir'
      const finalPath = isDir && !virtual.endsWith('/') ? `${virtual}/` : virtual
      if (isDeniedVirtualPath(finalPath)) return []
      if (seen.has(finalPath)) return []
      seen.add(finalPath)
      return [{
        path: finalPath,
        is_dir: isDir,
        size: 0,
        modified_at: '',
      }]
    })

    result.sort((a, b) => a.path.localeCompare(b.path))
    return result
  }

  async grepRaw(pattern: string, virtualPath = '/', globPattern?: string): Promise<GrepMatch[] | string> {
    if (isDeniedVirtualPath(virtualPath)) return []
    const sandboxPath = this.toSandboxPath(virtualPath)
    const regex = this.shellQuote(pattern)
    const relGlob = (globPattern ?? '').replace(/^\/+/, '')
    const prune = this.findPruneDirsClause()
    let cmd = ''
    if (relGlob) {
      const patterns = expandBracePattern(relGlob)
      if (patterns.length === 1) {
        const globMatcher = this.shellQuote(`./${patterns[0]}`)
        cmd = `cd ${this.shellQuote(sandboxPath)} && find . ${prune} -type f -path ${globMatcher} -print0 | xargs -0 grep -n -E ${regex} || true`
      } else {
        const findExpr = patterns
          .map((ptn) => `-path ${this.shellQuote(`./${ptn}`)}`)
          .join(' -o ')
        cmd = `cd ${this.shellQuote(sandboxPath)} && find . ${prune} -type f \\( ${findExpr} \\) -print0 | xargs -0 grep -n -E ${regex} || true`
      }
    } else {
      cmd = `cd ${this.shellQuote(sandboxPath)} && find . ${prune} -type f -print0 | xargs -0 grep -n -E ${regex} || true`
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

    // All uploaded files are materialized into a predictable folder at the project root so
    // generated apps can reference them without relying on user-provided paths.
    const attachedAssetsDirVirtual = '/attached_assets'
    const attachedAssetsDirSandbox = this.toSandboxPath(attachedAssetsDirVirtual)
    const attachedAssetsDirQuoted = this.shellQuote(attachedAssetsDirSandbox)

    const sanitizeFilename = (input: string) => {
      const base = path.posix.basename(toPosix(input))
      const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_')
      if (!cleaned || cleaned === '.' || cleaned === '..') return 'file'
      return cleaned
    }

    const nextPrefix = async () => {
      // Use a simple monotonic prefix (1-, 2-, 3-...) to avoid collisions and keep names readable.
      // We derive the next prefix by scanning the current directory once.
      let max = 0
      const listing = await this.runAllowFailure(`if [ -d ${attachedAssetsDirQuoted} ]; then ls -1 ${attachedAssetsDirQuoted}; fi`)
      for (const line of listing.split(/\r?\n/)) {
        const name = line.trim()
        if (!name) continue
        const match = /^(\d+)-/.exec(name)
        if (!match) continue
        const n = Number(match[1])
        if (Number.isFinite(n)) max = Math.max(max, n)
      }
      return max + 1
    }

    try {
      await this.runOk(`mkdir -p ${attachedAssetsDirQuoted}`)
    } catch {
      // If we can't create the directory, fail all uploads consistently.
      return files.map(([p]) => ({ path: toVirtualPath(p), error: 'permission_denied' })) as any
    }

    let prefix = await nextPrefix()

    for (const [virtualPath, bytes] of files) {
      const originalName = sanitizeFilename(virtualPath)
      const storedVirtualPath = `${attachedAssetsDirVirtual}/${prefix}-${originalName}`
      prefix += 1

      try {
        const sandboxPath = this.toSandboxPath(storedVirtualPath)
        const file = this.shellQuote(sandboxPath)
        const dir = this.shellQuote(path.posix.dirname(sandboxPath))
        const payload = Buffer.from(bytes).toString('base64')
        const cmd = `mkdir -p ${dir} && printf '%s' '${payload}' | base64 -d > ${file}`
        await this.runOk(cmd)
        responses.push({ path: toVirtualPath(storedVirtualPath), error: null })
      } catch {
        responses.push({ path: toVirtualPath(storedVirtualPath), error: 'permission_denied' })
      }
    }
    return responses as any
  }
}
