import { api } from 'encore.dev/api'
import fs from 'node:fs'
import path from 'node:path'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { assertE2BConfigured, resolveSandboxAppDir } from '../common/e2b'
import { connectSandboxWithRetry } from '../common/e2bSandbox'
import { parsePathPartAfter, writeJson } from '../common/http'
import { parseByteLimit, resolveWorkspaceRoot, toPosixRelPath } from '../common/workspace'
import { isDeniedEnvFile, isDeniedSensitiveFile } from '../common/fileSensitivity'
import { createStoredZipStream } from '../common/zip'
import { collectSandboxFiles, createZipStreamFromSandbox, resolveSandboxZipLimits } from '../common/sandboxZip'

import '../auth/auth'

type FileEntry = {
  absPath: string
  relPath: string
  size: number
  mtimeMs: number
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  '.aws',
  '.ssh',
  '.gnupg',
  '.kube',
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

async function collectFiles(rootDir: string, opts: { maxBytes: number; maxFiles: number }) {
  const files: FileEntry[] = []
  let total = 0

  const walk = async (absDir: string, relDir: string) => {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true })
    for (const ent of entries) {
      const name = ent.name
      if (name === '.' || name === '..') continue

      if (DEFAULT_EXCLUDE_DIRS.has(name)) {
        if (ent.isDirectory()) continue
      }

      if (isDeniedEnvFile(name) || isDeniedSensitiveFile(name)) continue

      const abs = path.join(absDir, name)
      const rel = relDir ? `${relDir}/${name}` : name

      let st: fs.Stats
      try {
        st = await fs.promises.lstat(abs)
      } catch {
        continue
      }

      if (st.isSymbolicLink()) continue

      if (st.isDirectory()) {
        await walk(abs, rel)
        continue
      }

      if (!st.isFile()) continue

      const size = st.size
      if (size > 0xffffffff) {
        throw new Error(`File too large for zip: ${rel}`)
      }

      total += size
      if (total > opts.maxBytes) {
        throw new Error('Zip exceeds ZIP_MAX_BYTES limit.')
      }

      files.push({
        absPath: abs,
        relPath: toPosixRelPath(rel),
        size,
        mtimeMs: st.mtimeMs,
      })

      if (files.length > opts.maxFiles) {
        throw new Error('Zip exceeds max file count limit.')
      }
    }
  }

  await walk(rootDir, '')
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files
}

async function* readFsFileChunks(absPath: string) {
  const rs = fs.createReadStream(absPath)
  try {
    for await (const chunk of rs as AsyncIterable<Uint8Array | ArrayBufferView | ArrayBuffer>) {
      yield chunk
    }
  } finally {
    rs.close?.()
  }
}

function createZipStream(files: FileEntry[]) {
  return createStoredZipStream(files, (file) => readFsFileChunks(file.absPath))
}

async function handleDownloadZip(_req: IncomingMessage, res: ServerResponse) {
  const root = resolveWorkspaceRoot()

  let st: fs.Stats
  try {
    st = await fs.promises.stat(root)
  } catch {
    writeJson(res, 400, { error: `WORKSPACE_ROOT not found: ${root}` })
    return
  }

  if (!st.isDirectory()) {
    writeJson(res, 400, { error: `WORKSPACE_ROOT is not a directory: ${root}` })
    return
  }

  const maxBytes = parseByteLimit(process.env.ZIP_MAX_BYTES, 250 * 1024 * 1024)
  const maxFiles = parseByteLimit(process.env.ZIP_MAX_FILES, 20_000)

  let files: FileEntry[]
  try {
    files = await collectFiles(root, { maxBytes, maxFiles })
  } catch (error) {
    writeJson(res, 413, { error: error instanceof Error ? error.message : String(error) })
    return
  }

  const stream = createZipStream(files)
  const reader = stream.getReader()

  res.statusCode = 200
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', 'attachment; filename="workspace.zip"')
  res.setHeader('cache-control', 'no-store')

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    reader.releaseLock()
  }
}

async function handleDownloadSandboxZip(req: IncomingMessage, res: ServerResponse) {
  assertE2BConfigured()

  const id = parsePathPartAfter(req, 'sandbox')
  if (!id) {
    writeJson(res, 400, { error: 'sandbox id is required' })
    return
  }

  const appDir = resolveSandboxAppDir()
  const { maxBytes, maxFiles } = resolveSandboxZipLimits()
  const sb = await connectSandboxWithRetry(id)

  let files: Awaited<ReturnType<typeof collectSandboxFiles>>
  try {
    files = await collectSandboxFiles(sb, appDir, { maxBytes, maxFiles })
  } catch (error) {
    writeJson(res, 413, { error: error instanceof Error ? error.message : String(error) })
    return
  }

  const stream = createZipStreamFromSandbox(sb, files)
  const reader = stream.getReader()

  res.statusCode = 200
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', 'attachment; filename="workspace.zip"')
  res.setHeader('cache-control', 'no-store')

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  } finally {
    reader.releaseLock()
  }
}

export const downloadZip = api.raw(
  { method: 'GET', path: '/download.zip', expose: false, auth: true },
  async (req, res) => handleDownloadZip(req, res),
)

export const downloadZipV1 = api.raw(
  { method: 'GET', path: '/v1/download.zip', expose: false, auth: true },
  async (req, res) => handleDownloadZip(req, res),
)

export const downloadSandboxZip = api.raw(
  { method: 'GET', path: '/sandbox/:id/download.zip', expose: false, auth: true },
  async (req, res) => handleDownloadSandboxZip(req, res),
)

export const downloadSandboxZipV1 = api.raw(
  { method: 'GET', path: '/v1/sandbox/:id/download.zip', expose: false, auth: true },
  async (req, res) => handleDownloadSandboxZip(req, res),
)
