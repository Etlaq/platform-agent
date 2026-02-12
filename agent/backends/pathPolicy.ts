import path from 'node:path'

const ALLOWED_WRITE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.sql',
  '.toml',
  '.yml',
  '.yaml',
  '.css',
  '.scss',
])

function extnameLower(virtualPath: string): string {
  const base = path.posix.basename(virtualPath)
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx).toLowerCase()
}

function isDeniedBasename(base: string): boolean {
  // Avoid accidental secret exfiltration.
  if (base === '.env') return true
  // Next.js commonly uses .env.local/.env.production/etc for real secrets.
  if (base.startsWith('.env.') && base !== '.env.example') return true
  if (base.endsWith('.pem') || base.endsWith('.key')) return true
  if (base === '.npmrc') return true
  if (base === '.git-credentials') return true
  return false
}

function isDeniedDirSegment(segment: string): boolean {
  return (
    segment === '.git' ||
    segment === 'node_modules' ||
    segment === '.next' ||
    segment === 'dist' ||
    segment === 'build' ||
    segment === '.cache' ||
    segment === '.turbo'
  )
}

export function normalizeVirtualPath(input: string): string {
  const cleaned = input.replace(/\\/g, '/')
  if (cleaned === '/' || cleaned === '') return ''

  const stripped = cleaned.replace(/^\/+/, '')
  const segments = stripped.split('/').filter(Boolean)
  if (!segments.length || stripped === '.') {
    throw new Error(`Invalid path: ${input}`)
  }
  for (const segment of segments) {
    if (segment === '..') throw new Error(`Invalid path: ${input}`)
  }
  return stripped
}

export function ensureAllowedPath(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath)
  if (!normalized) return '/'

  const segments = normalized.split('/').filter(Boolean)
  for (const segment of segments) {
    if (isDeniedDirSegment(segment)) {
      throw new Error(`Access denied: path contains '${segment}'`)
    }
  }

  const base = path.posix.basename(normalized)
  if (isDeniedBasename(base)) {
    throw new Error(`Access denied: '${base}'`)
  }
  return `/${normalized}`
}

export function isAllowedWritePath(virtualPath: string): boolean {
  const normalized = virtualPath.replace(/\\/g, '/')
  const base = path.posix.basename(normalized)
  if (isDeniedBasename(base)) return false
  if (base === '.env.example') return true

  const ext = extnameLower(normalized)
  return ALLOWED_WRITE_EXTS.has(ext)
}
