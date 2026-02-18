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
  'rollback_list_commits',
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
  AUTO_GIT_COMMIT: 'Optional: set to false to disable auto-commit after successful host runs (default: true).',
  AGENT_GIT_AUTHOR_NAME: 'Optional: git author name for auto-commits.',
  AGENT_GIT_AUTHOR_EMAIL: 'Optional: git author email for auto-commits.',
  AGENT_GIT_COMMITTER_NAME: 'Optional: git committer name for auto-commits.',
  AGENT_GIT_COMMITTER_EMAIL: 'Optional: git committer email for auto-commits.',
  ROLLBACK_DIR:
    'Override host-run rollback metadata directory (default: agent-runtime/rollbacks). Used for touched-file tracking.',
  AGENT_TIMEOUT_MS: 'Per-request timeout for the model provider client (milliseconds).',
  AGENT_MAX_RETRIES: 'Max retries for provider HTTP requests.',
  OPENAI_BASE_URL: 'Optional: override OpenAI base URL (useful for OpenAI-compatible local gateways).',
  ANTHROPIC_API_URL: 'Optional: override Anthropic base URL (useful for gateways / private endpoints).',
  GOOGLE_API_KEY: 'Optional: Google Generative AI API key (used when AGENT_PROVIDER=google).',
  GOOGLE_MODEL: 'Optional: Google model name (used when AGENT_PROVIDER=google, default: gemini-2.5-pro).',
  GOOGLE_BASE_URL: 'Optional: override Google Generative AI base URL.',
  GROQ_API_KEY: 'Optional: Groq API key (used when AGENT_PROVIDER=groq).',
  GROQ_MODEL: 'Optional: Groq model name (used when AGENT_PROVIDER=groq, default: llama-3.3-70b-versatile).',
  GROQ_BASE_URL: 'Optional: override Groq base URL (default: https://api.groq.com/openai/v1).',
  MISTRAL_API_KEY: 'Optional: Mistral API key (used when AGENT_PROVIDER=mistral).',
  MISTRAL_MODEL: 'Optional: Mistral model name (used when AGENT_PROVIDER=mistral, default: mistral-large-latest).',
  MISTRAL_BASE_URL: 'Optional: override Mistral base URL.',
  COHERE_API_KEY: 'Optional: Cohere API key (used when AGENT_PROVIDER=cohere).',
  COHERE_MODEL: 'Optional: Cohere model name (used when AGENT_PROVIDER=cohere, default: command-r-plus).',
  XAI_API_KEY: 'Optional: xAI API key (used when AGENT_PROVIDER=xai).',
  XAI_BASE_URL: 'Optional: override xAI base URL (default: https://api.x.ai/v1).',
  XAI_MODEL: 'Optional: xAI model name (used when AGENT_PROVIDER=xai).',
  ZAI_API_KEY: 'Optional: Z.AI API key (used when AGENT_PROVIDER=zai).',
  ZAI_BASE_URL: 'Optional: override Z.AI base URL (default: https://api.z.ai/api/paas/v4).',
  ZAI_USE_CODING_ENDPOINT:
    'Optional: set to true to default ZAI base URL to the coding endpoint (https://api.z.ai/api/coding/paas/v4).',
  ZAI_MODEL: 'Optional: Z.AI model name (used when AGENT_PROVIDER=zai, default: glm-4.7).',
  OPENROUTER_API_KEY: 'Optional: OpenRouter API key (used when AGENT_PROVIDER=openrouter).',
  OPENROUTER_MODEL:
    'Optional: OpenRouter model id (used when AGENT_PROVIDER=openrouter, default: openai/gpt-4o-mini).',
  OPENROUTER_BASE_URL: 'Optional: override OpenRouter base URL (default: https://openrouter.ai/api/v1).',
  OPENROUTER_SITE_URL:
    'Optional: value for OpenRouter HTTP-Referer header (recommended for leaderboard/rate-limit attribution).',
  OPENROUTER_APP_NAME:
    'Optional: value for OpenRouter X-Title header (recommended for app attribution).',
  KIMI_API_KEY: 'Optional: Kimi/Moonshot API key (used when AGENT_PROVIDER=kimi).',
  MOONSHOT_API_KEY: 'Alias of KIMI_API_KEY for compatibility.',
  KIMI_MODEL: 'Optional: Kimi model name (used when AGENT_PROVIDER=kimi, default: moonshot-v1-8k).',
  MOONSHOT_MODEL: 'Alias of KIMI_MODEL for compatibility.',
  KIMI_BASE_URL: 'Optional: override Kimi base URL (default: https://api.moonshot.ai/v1).',
  MOONSHOT_BASE_URL: 'Alias of KIMI_BASE_URL for compatibility.',
  QWEN_API_KEY: 'Optional: Qwen/DashScope API key (used when AGENT_PROVIDER=qwen).',
  ALIBABA_API_KEY: 'Alias of QWEN_API_KEY for compatibility.',
  DASHSCOPE_API_KEY: 'Alias of QWEN_API_KEY for compatibility.',
  QWEN_MODEL: 'Optional: Qwen model name (used when AGENT_PROVIDER=qwen, default: qwen-max).',
  ALIBABA_MODEL: 'Alias of QWEN_MODEL for compatibility.',
  DASHSCOPE_MODEL: 'Alias of QWEN_MODEL for compatibility.',
  QWEN_BASE_URL:
    'Optional: override Qwen/DashScope base URL (default: https://dashscope-intl.aliyuncs.com/compatible-mode/v1).',
  ALIBABA_BASE_URL: 'Alias of QWEN_BASE_URL for compatibility.',
  DASHSCOPE_BASE_URL: 'Alias of QWEN_BASE_URL for compatibility.',
}
