import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

interface GitCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RollbackCommitSummary {
  sha: string
  shortSha: string
  committedAt: string
  author: string
  subject: string
  isHead: boolean
}

export interface RollbackCommitList {
  branch: string | null
  head: string
  clean: boolean
  commits: RollbackCommitSummary[]
}

export interface RollbackToCommitResult {
  ok: boolean
  fromHead: string
  targetCommit: string
  newHead: string
  createdCommit: boolean
  changedFiles: number
  noChanges: boolean
  commitMessage: string | null
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
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
      })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function formatGitFailure(op: string, result: GitCommandResult) {
  const details = result.stderr.trim() || result.stdout.trim() || 'unknown error'
  return `${op} failed: ${details}`
}

async function requireGitRepo(workspaceRoot: string) {
  const repoCheck = await runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot)
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new Error('workspace is not a git repository')
  }
}

async function resolveHeadSha(workspaceRoot: string) {
  const head = await runGit(['rev-parse', 'HEAD'], workspaceRoot)
  if (head.code !== 0) {
    throw new Error(formatGitFailure('git rev-parse HEAD', head))
  }
  const sha = head.stdout.trim()
  if (!sha) throw new Error('failed to resolve current HEAD')
  return sha
}

async function resolveCommitSha(workspaceRoot: string, ref: string) {
  const commit = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], workspaceRoot)
  if (commit.code !== 0) {
    throw new Error(formatGitFailure(`git rev-parse --verify ${ref}^{commit}`, commit))
  }
  const sha = commit.stdout.trim()
  if (!sha) throw new Error('failed to resolve rollback target commit')
  return sha
}

async function isWorkingTreeClean(workspaceRoot: string) {
  const status = await runGit(['status', '--porcelain'], workspaceRoot)
  if (status.code !== 0) {
    throw new Error(formatGitFailure('git status --porcelain', status))
  }
  return status.stdout.trim().length === 0
}

function safeRelPath(relPath: string) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized === '.') {
    throw new Error(`invalid git path: ${relPath}`)
  }
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length) throw new Error(`invalid git path: ${relPath}`)
  for (const seg of segments) {
    if (seg === '..') throw new Error(`invalid git path: ${relPath}`)
  }
  return normalized
}

function isInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  const rootDrive = path.parse(resolvedRoot).root
  if (resolvedRoot === rootDrive) return true
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  )
}

function parseNullTerminatedList(raw: string) {
  return raw
    .split('\u0000')
    .filter((entry) => entry.length > 0)
}

async function listTrackedFiles(workspaceRoot: string, ref: string) {
  const list = await runGit(['ls-tree', '-r', '--name-only', '-z', ref], workspaceRoot)
  if (list.code !== 0) {
    throw new Error(formatGitFailure(`git ls-tree -r --name-only -z ${ref}`, list))
  }
  return parseNullTerminatedList(list.stdout).map(safeRelPath)
}

function clampListLimit(limit: number | undefined) {
  const raw = Number(limit)
  if (!Number.isFinite(raw)) return 30
  return Math.max(1, Math.min(200, Math.trunc(raw)))
}

export async function listRollbackCommits(params: {
  workspaceRoot: string
  limit?: number
}): Promise<RollbackCommitList> {
  const workspaceRoot = path.resolve(params.workspaceRoot)
  await requireGitRepo(workspaceRoot)

  const head = await resolveHeadSha(workspaceRoot)
  const clean = await isWorkingTreeClean(workspaceRoot)
  const limit = clampListLimit(params.limit)
  const format = '%H%x1f%h%x1f%cI%x1f%an%x1f%s'

  const branchRes = await runGit(['symbolic-ref', '--short', 'HEAD'], workspaceRoot)
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null

  const log = await runGit(['log', `--max-count=${limit}`, `--pretty=format:${format}`], workspaceRoot)
  if (log.code !== 0) {
    throw new Error(formatGitFailure('git log', log))
  }

  const commits = log.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', shortSha = '', committedAt = '', author = '', subject = ''] = line.split('\u001f')
      return {
        sha,
        shortSha,
        committedAt,
        author,
        subject,
        isHead: sha === head,
      }
    })
    .filter((commit) => commit.sha.length > 0)

  return {
    branch,
    head,
    clean,
    commits,
  }
}

export async function rollbackToCommit(params: {
  workspaceRoot: string
  commitSha: string
}): Promise<RollbackToCommitResult> {
  const workspaceRoot = path.resolve(params.workspaceRoot)
  await requireGitRepo(workspaceRoot)

  const targetRef = String(params.commitSha ?? '').trim()
  if (!targetRef) {
    throw new Error('commitSha is required')
  }

  const clean = await isWorkingTreeClean(workspaceRoot)
  if (!clean) {
    throw new Error('working tree must be clean before rollback')
  }

  const fromHead = await resolveHeadSha(workspaceRoot)
  const targetCommit = await resolveCommitSha(workspaceRoot, targetRef)

  if (fromHead === targetCommit) {
    return {
      ok: true,
      fromHead,
      targetCommit,
      newHead: fromHead,
      createdCommit: false,
      changedFiles: 0,
      noChanges: true,
      commitMessage: null,
    }
  }

  const headFiles = new Set(await listTrackedFiles(workspaceRoot, fromHead))
  const targetFiles = new Set(await listTrackedFiles(workspaceRoot, targetCommit))

  const checkout = await runGit(['checkout', targetCommit, '--', '.'], workspaceRoot)
  if (checkout.code !== 0) {
    throw new Error(formatGitFailure(`git checkout ${targetCommit} -- .`, checkout))
  }

  for (const relPath of headFiles) {
    if (targetFiles.has(relPath)) continue
    const absPath = path.join(workspaceRoot, relPath)
    if (!isInside(workspaceRoot, absPath)) {
      throw new Error(`refusing to delete path outside workspace: ${relPath}`)
    }
    if (fs.existsSync(absPath)) {
      fs.rmSync(absPath, { recursive: true, force: true })
    }
  }

  const add = await runGit(['add', '-A'], workspaceRoot)
  if (add.code !== 0) {
    throw new Error(formatGitFailure('git add -A', add))
  }

  const changed = await runGit(['diff', '--cached', '--name-only'], workspaceRoot)
  if (changed.code !== 0) {
    throw new Error(formatGitFailure('git diff --cached --name-only', changed))
  }
  const changedFiles = changed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length

  const diffQuiet = await runGit(['diff', '--cached', '--quiet'], workspaceRoot)
  if (diffQuiet.code === 0) {
    return {
      ok: true,
      fromHead,
      targetCommit,
      newHead: fromHead,
      createdCommit: false,
      changedFiles,
      noChanges: true,
      commitMessage: null,
    }
  }
  if (diffQuiet.code !== 1) {
    throw new Error(formatGitFailure('git diff --cached --quiet', diffQuiet))
  }

  const commitMessage = `chore(rollback): restore snapshot ${targetCommit.slice(0, 12)}`
  const commit = await runGit(['commit', '-m', commitMessage, '--no-verify'], workspaceRoot)
  if (commit.code !== 0) {
    throw new Error(formatGitFailure('git commit', commit))
  }

  const newHead = await resolveHeadSha(workspaceRoot)
  return {
    ok: true,
    fromHead,
    targetCommit,
    newHead,
    createdCommit: true,
    changedFiles,
    noChanges: false,
    commitMessage,
  }
}
