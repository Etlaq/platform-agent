import fs from 'node:fs'
import path from 'node:path'
import type { RollbackManager } from '../../../rollback/rollbackManager'
import { fileExists } from './fileSystem'

export function parseDotEnvKeys(content: string) {
  const keys = new Set<string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const unexported = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const idx = unexported.indexOf('=')
    if (idx === -1) continue
    const key = unexported.slice(0, idx).trim()
    // Conservative env var name check to avoid weird parsing edge cases.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    keys.add(key)
  }
  return [...keys].sort((a, b) => a.localeCompare(b))
}

export function upsertEnvExample(workspaceRoot: string, rollback: RollbackManager, kv: Record<string, string>) {
  const p = path.join(workspaceRoot, '.env.example')
  rollback.recordBeforeChange(p, workspaceRoot)
  const existing = fileExists(p) ? fs.readFileSync(p, 'utf8') : ''
  const present = new Set<string>()
  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    present.add(trimmed.slice(0, idx).trim())
  }

  const additions: string[] = []
  for (const [k, v] of Object.entries(kv)) {
    if (present.has(k)) continue
    additions.push(`${k}=${v}`)
  }

  if (!additions.length) return { path: p, added: [] as string[] }

  const next = (existing.trimEnd() ? existing.trimEnd() + '\n\n' : '') + additions.join('\n') + '\n'
  fs.writeFileSync(p, next, 'utf8')
  return { path: p, added: additions.map((line) => line.split('=')[0]) }
}
