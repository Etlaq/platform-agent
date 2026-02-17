import { APIError } from 'encore.dev/api'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { apiFailure, apiSuccess } from './apiContract'

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

export function parsePathPartAfter(req: IncomingMessage, segment: string, offset = 1) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const segIndex = parts.findIndex((part) => part === segment)
  if (segIndex === -1) return ''
  return parts[segIndex + offset] ?? ''
}

export function writeApiSuccess<T>(res: ServerResponse, status: number, data: T) {
  writeJson(res, status, apiSuccess(data))
}

export function writeApiError(res: ServerResponse, status: number, code: string, message: string) {
  writeJson(res, status, apiFailure(code, message))
}
