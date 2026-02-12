import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true })
}

export function readJsonFile<T>(p: string): T {
  const raw = fs.readFileSync(p, 'utf8')
  return JSON.parse(raw) as T
}

export function writeJsonFile(p: string, value: unknown) {
  const content = JSON.stringify(value, null, 2) + '\n'
  fs.writeFileSync(p, content, 'utf8')
}

export function fileExists(p: string) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

export function pickCodeRoot(workspaceRoot: string) {
  const hasSrc = fileExists(path.join(workspaceRoot, 'src'))
  return hasSrc ? path.join(workspaceRoot, 'src') : workspaceRoot
}
