import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { resolveWorkspaceRoot } from '../agent/runtime/config'

type WorkspaceBackend = 'host' | 'e2b' | null | undefined

interface GitCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitCommitResult {
  ok: boolean
  skipped?: string
  error?: string
  commitSha?: string
}

function shouldAutoGitCommit() {
  return process.env.AUTO_GIT_COMMIT !== 'false'
}

function runGit(args: string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(process.env.AGENT_GIT_AUTHOR_NAME ? { GIT_AUTHOR_NAME: process.env.AGENT_GIT_AUTHOR_NAME } : {}),
        ...(process.env.AGENT_GIT_AUTHOR_EMAIL ? { GIT_AUTHOR_EMAIL: process.env.AGENT_GIT_AUTHOR_EMAIL } : {}),
        ...(process.env.AGENT_GIT_COMMITTER_NAME ? { GIT_COMMITTER_NAME: process.env.AGENT_GIT_COMMITTER_NAME } : {}),
        ...(process.env.AGENT_GIT_COMMITTER_EMAIL ? { GIT_COMMITTER_EMAIL: process.env.AGENT_GIT_COMMITTER_EMAIL } : {}),
      },
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export async function commitRunToGit(params: {
  runId: string
  workspaceBackend?: WorkspaceBackend
}): Promise<GitCommitResult> {
  if (!shouldAutoGitCommit()) {
    return { ok: false, skipped: 'disabled' }
  }

  if ((params.workspaceBackend ?? 'host') !== 'host') {
    return { ok: false, skipped: 'non_host_workspace' }
  }

  const workspaceRoot = resolveWorkspaceRoot()
  if (!fs.existsSync(workspaceRoot)) {
    return { ok: false, skipped: 'workspace_missing' }
  }

  const repoCheck = await runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    return { ok: false, skipped: 'not_git_repo' }
  }

  const addRes = await runGit(['add', '-A'], workspaceRoot)
  if (addRes.code !== 0) {
    return {
      ok: false,
      error: `git add failed: ${addRes.stderr.trim() || addRes.stdout.trim() || 'unknown error'}`,
    }
  }

  const diffRes = await runGit(['diff', '--cached', '--quiet'], workspaceRoot)
  if (diffRes.code === 0) {
    return { ok: false, skipped: 'no_changes' }
  }
  if (diffRes.code !== 1) {
    return {
      ok: false,
      error: `git diff --cached --quiet failed: ${diffRes.stderr.trim() || diffRes.stdout.trim() || 'unknown error'}`,
    }
  }

  const message = `chore(agent): apply run ${params.runId}`
  const commitRes = await runGit(['commit', '-m', message, '--no-verify'], workspaceRoot)
  if (commitRes.code !== 0) {
    return {
      ok: false,
      error: `git commit failed: ${commitRes.stderr.trim() || commitRes.stdout.trim() || 'unknown error'}`,
    }
  }

  const shaRes = await runGit(['rev-parse', 'HEAD'], workspaceRoot)
  const commitSha = shaRes.code === 0 ? shaRes.stdout.trim() : undefined
  return { ok: true, commitSha }
}
