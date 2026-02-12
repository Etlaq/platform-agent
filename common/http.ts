import { APIError } from 'encore.dev/api'
import { type IncomingMessage, type ServerResponse } from 'node:http'

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req)
  if (body.length === 0) return {} as T

  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw APIError.invalidArgument('Invalid JSON payload')
  }
}

export function writeJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

export function parsePathPart(req: IncomingMessage, index: number) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  return parts[index] ?? ''
}
