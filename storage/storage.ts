import { Bucket } from 'encore.dev/storage/objects'
import fs from 'node:fs'
import path from 'node:path'
import { RollbackManager } from '../agent/rollback/rollbackManager'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const artifactsBucket = new Bucket('agent-artifacts', {
  versioned: false,
})

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const maybe = error as { code?: unknown; message?: unknown }
  return maybe.code === 'not_found' || String(maybe.message ?? '').toLowerCase().includes('not found')
}

export function rollbackManifestKey(runId: string) {
  return `rollbacks/${runId}/manifest.json`
}

export async function putJsonObject(key: string, payload: unknown) {
  const body = encoder.encode(JSON.stringify(payload, null, 2))
  await artifactsBucket.upload(key, Buffer.from(body), { contentType: 'application/json' })
}

export async function getJsonObject<T>(key: string): Promise<T | null> {
  try {
    const payload = await artifactsBucket.download(key)
    return JSON.parse(decoder.decode(payload)) as T
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

function getRollbackRoot() {
  const raw = process.env.ROLLBACK_DIR || 'agent-runtime/rollbacks'
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}

export async function syncRollbackManifest(runId: string) {
  const rollbackRoot = getRollbackRoot()
  const manifestPath = RollbackManager.manifestPath({ runId, rollbackRoot })
  const raw = await fs.promises.readFile(manifestPath, 'utf8')
  await putJsonObject(rollbackManifestKey(runId), JSON.parse(raw))
}

export async function readRollbackManifestFromDisk(runId: string) {
  const rollbackRoot = getRollbackRoot()
  const manifestPath = RollbackManager.manifestPath({ runId, rollbackRoot })
  const raw = await fs.promises.readFile(manifestPath, 'utf8')
  return JSON.parse(raw)
}

export function rollbackRootPath() {
  return getRollbackRoot()
}
