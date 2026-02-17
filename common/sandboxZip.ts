import path from 'node:path'
import { Sandbox } from '@e2b/code-interpreter'
import { isDeniedEnvFile, isDeniedSensitiveFile } from './fileSensitivity'
import { createStoredZipStream, readWebStream } from './zip'
import { parseByteLimit } from './workspace'

export type SandboxZipFile = {
  absPath: string
  relPath: string
  size: number
  mtimeMs: number
}

const EXCLUDE_SANDBOX_DIRS = new Set([
  '.aws',
  '.ssh',
  '.gnupg',
  '.kube',
  '.config',
  '.bun',
  '.local',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.vscode',
  '.idea',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.agents',
  '.turbo',
  '.cache',
  'tmp',
])

const ALLOW_DOTFILES = new Set(['.env.example', '.gitignore'])

export function resolveSandboxZipLimits() {
  return {
    maxBytes: parseByteLimit(process.env.ZIP_MAX_BYTES, 250 * 1024 * 1024),
    maxFiles: parseByteLimit(process.env.ZIP_MAX_FILES, 20_000),
  }
}

export async function collectSandboxFiles(
  sb: Sandbox,
  rootDir: string,
  opts: { maxBytes: number; maxFiles: number },
): Promise<SandboxZipFile[]> {
  const files: SandboxZipFile[] = []
  const queue: Array<{ absDir: string; relDir: string }> = [{ absDir: rootDir, relDir: '' }]
  let total = 0

  while (queue.length) {
    const current = queue.pop()
    if (!current) break

    const entries = await sb.files.list(current.absDir).catch(() => [])
    for (const ent of entries as any[]) {
      const name = String(ent.name ?? '')
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') && ent.type === 'dir' && name !== '.git') continue
      if (EXCLUDE_SANDBOX_DIRS.has(name)) continue
      if (isDeniedEnvFile(name, { allowEnvExample: true })) continue
      if (isDeniedSensitiveFile(name)) continue
      if (ent.symlinkTarget) continue

      const absPath = path.posix.join(current.absDir, name)
      const relPath = current.relDir ? `${current.relDir}/${name}` : name

      const type = String(ent.type ?? '')
      if (type === 'dir') {
        queue.push({ absDir: absPath, relDir: relPath })
        continue
      }
      if (type !== 'file') continue
      if (name.startsWith('.') && !ALLOW_DOTFILES.has(name)) continue

      const size = Number(ent.size ?? 0) || 0
      if (size > 0xffffffff) {
        throw new Error(`File too large for zip: ${relPath}`)
      }

      total += size
      if (total > opts.maxBytes) {
        throw new Error('Zip exceeds ZIP_MAX_BYTES limit.')
      }

      files.push({
        absPath,
        relPath,
        size,
        mtimeMs: ent.modifiedTime instanceof Date ? ent.modifiedTime.getTime() : Date.now(),
      })

      if (files.length > opts.maxFiles) {
        throw new Error('Zip exceeds max file count limit.')
      }
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files
}

async function readSandboxChunks(sb: Sandbox, absPath: string) {
  const stream = await sb.files.read(absPath, { format: 'stream' as const })
  return readWebStream(stream)
}

export function createZipStreamFromSandbox(sb: Sandbox, files: SandboxZipFile[]) {
  return createStoredZipStream(files, (file) => readSandboxChunks(sb, file.absPath))
}

export async function buildSandboxZipBuffer(sb: Sandbox, rootDir: string) {
  const limits = resolveSandboxZipLimits()
  const files = await collectSandboxFiles(sb, rootDir, limits)
  const stream = createZipStreamFromSandbox(sb, files)
  const reader = stream.getReader()
  const chunks: Buffer[] = []

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return {
    buffer: Buffer.concat(chunks),
    fileCount: files.length,
  }
}
