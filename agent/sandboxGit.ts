import type { Sandbox } from '@e2b/code-interpreter'

interface SandboxGitApi {
  init: (path: string) => Promise<unknown>
  configureUser?: (name: string, email: string, opts?: { scope?: string; path?: string }) => Promise<unknown>
  add?: (path: string, opts?: { all?: boolean }) => Promise<unknown>
  commit?: (path: string, message: string, opts?: { allowEmpty?: boolean }) => Promise<unknown>
}

function getSandboxGitApi(sandbox: Sandbox): SandboxGitApi | null {
  const git = (sandbox as unknown as { git?: unknown }).git
  if (!git || typeof (git as { init?: unknown }).init !== 'function') return null
  return git as SandboxGitApi
}

/**
 * Best-effort git init + initial commit inside an E2B sandbox.
 * Never throws — failures are silently ignored so the run is not affected.
 */
export async function initSandboxGit(sandbox: Sandbox, appDir: string): Promise<void> {
  try {
    const gitApi = getSandboxGitApi(sandbox)
    if (!gitApi) return

    const authorName = process.env.AGENT_GIT_AUTHOR_NAME || 'Etlaq Agent'
    const authorEmail = process.env.AGENT_GIT_AUTHOR_EMAIL || 'agent@local'

    await gitApi.init(appDir).catch(() => undefined)
    if (typeof gitApi.configureUser === 'function') {
      await gitApi.configureUser(authorName, authorEmail, { scope: 'local', path: appDir }).catch(() => undefined)
    }
    if (typeof gitApi.add === 'function') {
      await gitApi.add(appDir, { all: true }).catch(() => undefined)
    }
    if (typeof gitApi.commit === 'function') {
      await gitApi.commit(appDir, 'chore: initial snapshot', { allowEmpty: true }).catch(() => undefined)
    }
  } catch {
    // ignore
  }
}

/**
 * Best-effort final snapshot commit inside an E2B sandbox.
 * Used to ensure the downloaded workspace zip has a usable git history.
 * Never throws.
 */
export async function snapshotSandboxGit(sandbox: Sandbox, appDir: string, runId: string): Promise<void> {
  try {
    const gitApi = getSandboxGitApi(sandbox)
    if (!gitApi) return

    const authorName = process.env.AGENT_GIT_AUTHOR_NAME || 'Etlaq Agent'
    const authorEmail = process.env.AGENT_GIT_AUTHOR_EMAIL || 'agent@local'

    await gitApi.init(appDir).catch(() => undefined)
    if (typeof gitApi.configureUser === 'function') {
      await gitApi.configureUser(authorName, authorEmail, { scope: 'local', path: appDir }).catch(() => undefined)
    }
    if (typeof gitApi.add === 'function') {
      await gitApi.add(appDir, { all: true }).catch(() => undefined)
    }
    if (typeof gitApi.commit === 'function') {
      await gitApi.commit(appDir, `chore: snapshot run ${runId}`, { allowEmpty: true }).catch(() => undefined)
    }
  } catch {
    // ignore
  }
}
