import { Bucket } from 'encore.dev/storage/objects'

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
