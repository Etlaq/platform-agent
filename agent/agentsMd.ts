import fs from 'node:fs'
import path from 'node:path'

import type { BackendProtocol } from 'deepagents'

export const NOTES_START = '<!-- AGENTS_NOTES_START -->'
export const NOTES_END = '<!-- AGENTS_NOTES_END -->'

let cachedTemplate: string | null = null

export function loadAgentsMdTemplate() {
  if (cachedTemplate) return cachedTemplate
  const override = process.env.AGENTS_TEMPLATE_PATH
  const runtimeTemplatePath = path.resolve(process.cwd(), 'agent-runtime', 'AGENTS.md')
  const selectedPath = override
    ? override
    : fs.existsSync(runtimeTemplatePath)
      ? runtimeTemplatePath
      : new URL('./templates/AGENTS.project.md', import.meta.url)
  const raw = fs.readFileSync(selectedPath, 'utf8')
  cachedTemplate = raw.replace(/\r\n/g, '\n').trimEnd() + '\n'
  return cachedTemplate
}

function extractNotes(existing: string) {
  const text = existing.replace(/\r\n/g, '\n')
  const start = text.indexOf(NOTES_START)
  const end = text.indexOf(NOTES_END)
  if (start !== -1 && end !== -1 && end > start) {
    const between = text.slice(start + NOTES_START.length, end)
    return between.replace(/^\n+/, '').replace(/\n+$/, '')
  }

  // Fallback: preserve anything under a Notes header.
  const m = text.match(/^##\s+Notes\b[^\n]*\n([\s\S]*)$/m)
  if (m && m[1]) return m[1].trim()

  return ''
}

function renderWithNotes(template: string, notes: string) {
  const text = template.replace(/\r\n/g, '\n')
  const start = text.indexOf(NOTES_START)
  const end = text.indexOf(NOTES_END)
  const cleanedNotes = notes.trim()

  if (start !== -1 && end !== -1 && end > start) {
    const before = text.slice(0, start + NOTES_START.length)
    const after = text.slice(end)
    const middle = cleanedNotes ? `\n${cleanedNotes}\n` : '\n'
    return (before + middle + after).trimEnd() + '\n'
  }

  // If template doesn't have markers, append them.
  const out =
    text.trimEnd() +
    '\n\n## Notes (Append Only)\n' +
    NOTES_START +
    '\n' +
    (cleanedNotes ? `${cleanedNotes}\n` : '') +
    NOTES_END +
    '\n'
  return out
}

async function readPlain(backend: BackendProtocol, filePath: string) {
  try {
    const raw = await backend.readRaw(filePath)
    return { ok: true as const, content: (raw.content ?? []).join('\n') }
  } catch {
    return { ok: false as const, content: '' }
  }
}

async function writeOrReplace(backend: BackendProtocol, filePath: string, content: string) {
  const current = await readPlain(backend, filePath)
  if (!current.ok) {
    const res = await backend.write(filePath, content)
    if (!res.error) return { ok: true as const }
    // If write is "exists" or anything else, fall through to edit.
  } else {
    const res = await backend.edit(filePath, current.content, content, false)
    if (!res.error) return { ok: true as const }
  }

  // Retry with fresh read and full-content replacement (covers races).
  const fresh = await readPlain(backend, filePath)
  if (fresh.ok) {
    const res = await backend.edit(filePath, fresh.content, content, false)
    if (!res.error) return { ok: true as const }
    return { ok: false as const, error: res.error }
  }

  const res = await backend.write(filePath, content)
  if (!res.error) return { ok: true as const }
  return { ok: false as const, error: res.error }
}

export async function ensureAgentsMd(params: {
  backend: BackendProtocol
  filePath?: string
  template?: string
}) {
  const filePath = params.filePath ?? '/AGENTS.md'
  const template = (params.template ?? loadAgentsMdTemplate()).replace(/\r\n/g, '\n')

  const existing = await readPlain(params.backend, filePath)
  const notes = existing.ok ? extractNotes(existing.content) : ''
  const seeded = renderWithNotes(template, notes)

  return writeOrReplace(params.backend, filePath, seeded)
}

function redactLikelySecrets(input: string) {
  let s = input

  // Well-known token formats.
  s = s.replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_<redacted>')
  s = s.replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-<redacted>')
  // Z.AI key format observed: <32-hex>.<alnum>
  s = s.replace(/\b[a-f0-9]{32}\.[A-Za-z0-9]{8,}\b/gi, '<redacted>')
  // JWTs (three base64url segments).
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt_<redacted>')

  // Authorization headers/tokens.
  s = s.replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer <redacted>')
  s = s.replace(/(\bauthorization\b\s*[:=]\s*)(?:Bearer\s+)?[^\s'"]+/gi, '$1<redacted>')

  // Headers/env/kv pairs containing secret-y names.
  s = s.replace(
    /(\b[a-z0-9-]*?(?:api-?key|token|secret|password)[a-z0-9-]*\b)\s*:\s*[^\s'"]+/gi,
    '$1: <redacted>',
  )
  s = s.replace(
    /(\b[A-Za-z0-9_]*(?:API|ACCESS|SECRET|TOKEN|PASS(?:WORD)?|KEY)[A-Za-z0-9_]*\b)\s*[:=]\s*[^\s'"]+/g,
    '$1=<redacted>',
  )
  // JSON-ish string fields.
  s = s.replace(
    /("(?:apiKey|api_key|api-key|token|secret|password|accessToken|refreshToken)"\s*:\s*")[^"]+(")/gi,
    '$1<redacted>$2',
  )
  s = s.replace(
    /(\b(?:apiKey|api_key|api-key|token|secret|password|accessToken|refreshToken)\b\s*[:=]\s*)[^\s'"]+/gi,
    '$1<redacted>',
  )

  // Catch-all: redact long opaque tokens that often show up in tool inputs.
  // Prefer over-redaction here to avoid leaking secrets into AGENTS.md.
  s = s.replace(
    /\b(?![a-f0-9]{40}\b)(?![a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b)[A-Za-z0-9][A-Za-z0-9._-]{23,}\b/g,
    '<redacted>',
  )

  return s
}

export async function appendAgentsNote(params: {
  backend: BackendProtocol
  note: string
  filePath?: string
}) {
  const filePath = params.filePath ?? '/AGENTS.md'
  const rawNote = params.note.replace(/\r\n/g, '\n').trim()
  if (!rawNote) return { ok: true as const }

  const noteLine = redactLikelySecrets(rawNote.replace(/\s+/g, ' ')).slice(0, 400)
  const timestamp = new Date().toISOString()
  const line = `- ${timestamp}: ${noteLine}`

  let existing = await readPlain(params.backend, filePath)
  if (!existing.ok) {
    await ensureAgentsMd({ backend: params.backend, filePath }).catch(() => {})
    existing = await readPlain(params.backend, filePath)
  }
  if (!existing.ok) return { ok: false as const, error: 'AGENTS.md missing/unreadable' }

  const text = existing.content.replace(/\r\n/g, '\n')
  const start = text.indexOf(NOTES_START)
  const end = text.indexOf(NOTES_END)
  if (start === -1 || end === -1 || end <= start) {
    // Repair by reseeding, then try again.
    await ensureAgentsMd({ backend: params.backend, filePath }).catch(() => {})
    return appendAgentsNote({ ...params, filePath })
  }

  const before = text.slice(0, start + NOTES_START.length)
  const middle = text.slice(start + NOTES_START.length, end)
  const after = text.slice(end)
  const middleLines = middle.replace(/^\n+/, '').replace(/\n+$/, '').split('\n').filter(Boolean)
  const last = middleLines[middleLines.length - 1] ?? ''
  if (last.includes(noteLine)) return { ok: true as const }

  const updatedMiddle =
    (middle.replace(/\n*$/, '\n').replace(/^\n*/, '\n') + line + '\n').replace(/^\n+/, '\n')
  const updated = (before + updatedMiddle + after).trimEnd() + '\n'

  const res = await params.backend.edit(filePath, existing.content, updated, false)
  if (!res.error) return { ok: true as const }

  // If file changed, retry once with a fresh read.
  const fresh = await readPlain(params.backend, filePath)
  if (fresh.ok) {
    const res2 = await params.backend.edit(filePath, fresh.content, updated, false)
    if (!res2.error) return { ok: true as const }
    return { ok: false as const, error: res2.error }
  }

  return { ok: false as const, error: res.error }
}
