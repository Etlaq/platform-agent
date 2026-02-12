const DENIED_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
])

export function isDeniedEnvFile(name: string, options?: { allowEnvExample?: boolean }) {
  if (name === '.env') return true
  if (!name.startsWith('.env.')) return false
  if (options?.allowEnvExample && name === '.env.example') return false
  return true
}

export function isDeniedSensitiveFile(name: string) {
  const lower = name.toLowerCase()
  if (DENIED_BASENAMES.has(lower)) return true
  if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12') || lower.endsWith('.pfx')) return true
  if (lower === 'id_rsa' || lower === 'id_rsa.pub') return true
  if (lower === 'id_ed25519' || lower === 'id_ed25519.pub') return true
  if (lower === 'id_ecdsa' || lower === 'id_ecdsa.pub') return true
  return false
}
