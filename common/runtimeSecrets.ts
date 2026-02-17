import { secret } from 'encore.dev/config'

type SecretBinding = {
  envKey: string
  read: () => string
}

const SECRET_BINDINGS: SecretBinding[] = [
  { envKey: 'AGENT_PROVIDER', read: secret('AGENT_PROVIDER') },
  { envKey: 'ZAI_API_KEY', read: secret('ZAI_API_KEY') },
  { envKey: 'ZAI_MODEL', read: secret('ZAI_MODEL') },
  { envKey: 'ANTHROPIC_API_KEY', read: secret('ANTHROPIC_API_KEY') },
  { envKey: 'E2B_API_KEY', read: secret('E2B_API_KEY') },
  { envKey: 'E2B_TEMPLATE', read: secret('E2B_TEMPLATE') },
]

function normalizeSecretValue(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// In Encore cloud, secret values should be sourced via secret() lookups.
// We hydrate process.env so existing provider/runtime code can keep using env access.
export function hydrateRuntimeEnvFromSecrets() {
  for (const binding of SECRET_BINDINGS) {
    const current = normalizeSecretValue(process.env[binding.envKey])
    if (current) continue

    try {
      const next = normalizeSecretValue(binding.read())
      if (next) {
        process.env[binding.envKey] = next
      }
    } catch {
      // Optional at runtime; unresolved secrets are handled by existing validation paths.
    }
  }
}
