export const API_VERSION = 'v1' as const

export interface ApiMeta {
  apiVersion: typeof API_VERSION
  ts: string
}

export interface ApiSuccess<T> {
  ok: true
  data: T
  meta: ApiMeta
}

export interface ApiFailure {
  ok: false
  error: {
    code: string
    message: string
  }
  meta: ApiMeta
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure

export function makeApiMeta(ts = new Date().toISOString()): ApiMeta {
  return { apiVersion: API_VERSION, ts }
}

export function apiSuccess<T>(data: T, ts?: string): ApiSuccess<T> {
  return {
    ok: true,
    data,
    meta: makeApiMeta(ts),
  }
}

export function apiFailure(code: string, message: string, ts?: string): ApiFailure {
  return {
    ok: false,
    error: { code, message },
    meta: makeApiMeta(ts),
  }
}
