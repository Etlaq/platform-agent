import fs from 'node:fs'
import path from 'node:path'

export function readPackageName() {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json')
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const parsed = JSON.parse(raw) as { name?: string }
    return parsed.name ?? 'agent'
  } catch {
    return 'agent'
  }
}

export const CAPABILITY_ACTIONS = [
  'detect_project',
  'secrets_status',
  'secrets_read_env_example',
  'secrets_sync_env_example',
  'add_dependencies',
  'run_install',
  'run_next_build',
  'run_typecheck',
  'generate_drizzle_migration',
  'scaffold_authjs_supabase_drizzle',
  'scaffold_cron_supabase_daily',
  'validate_env',
  'rollback_run',
] as const

export const CAPABILITY_ENV: Record<string, string> = {
  ALLOW_HOST_INSTALLS: 'Set to true to allow running bun install/build/typecheck from the server process.',
  WORKSPACE_ROOT:
    'Optional: absolute path to the workspace root (default: /workspace if present, else process cwd).',
  SANDBOX_APP_DIR:
    'Optional: working directory inside E2B sandboxes for /sandbox/dev/start (default: /home/user).',
  E2B_API_KEY: 'Required for /exec and /sandbox/* when using E2B.',
  E2B_TEMPLATE: 'Required: E2B template ID/alias to use (your built Next.js template).',
  ZIP_MAX_BYTES: 'Optional: max total bytes allowed in /download.zip (default: 262144000).',
  ZIP_MAX_FILES: 'Optional: max number of files allowed in /download.zip (default: 20000).',
  ROLLBACK_DIR: 'Override rollback snapshot root directory (default: agent-runtime/rollbacks).',
  AGENT_TIMEOUT_MS: 'Per-request timeout for the model provider client (milliseconds).',
  AGENT_MAX_RETRIES: 'Max retries for provider HTTP requests.',
  OPENAI_BASE_URL: 'Optional: override OpenAI base URL (useful for OpenAI-compatible local gateways).',
  ANTHROPIC_API_URL: 'Optional: override Anthropic base URL (useful for gateways / private endpoints).',
  XAI_API_KEY: 'Optional: xAI API key (used when AGENT_PROVIDER=xai).',
  XAI_BASE_URL: 'Optional: override xAI base URL (default: https://api.x.ai/v1).',
  XAI_MODEL: 'Optional: xAI model name (used when AGENT_PROVIDER=xai).',
  ZAI_API_KEY: 'Optional: Z.AI API key (used when AGENT_PROVIDER=zai).',
  ZAI_BASE_URL: 'Optional: override Z.AI base URL (default: https://api.z.ai/api/paas/v4).',
  ZAI_USE_CODING_ENDPOINT:
    'Optional: set to true to default ZAI base URL to the coding endpoint (https://api.z.ai/api/coding/paas/v4).',
  ZAI_MODEL: 'Optional: Z.AI model name (used when AGENT_PROVIDER=zai, default: glm-4.7).',
}
