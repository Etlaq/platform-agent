import fs from 'node:fs'
import path from 'node:path'
import { listRollbackCommits, rollbackToCommit } from '../../../rollback/gitRollback'
import { fileExists } from '../helpers/fileSystem'
import { parseDotEnvKeys, upsertEnvExample } from '../helpers/envFiles'
import type { ProjectActionInputByAction } from '../schemas'
import type { ProjectActionContext } from '../types'

export function detectProjectAction(context: ProjectActionContext) {
  return context.detection
}

export function secretsStatusAction(context: ProjectActionContext) {
  const envPath = path.join(context.params.workspaceRoot, '.env')
  const envExamplePath = path.join(context.params.workspaceRoot, '.env.example')
  const envExists = fileExists(envPath)
  const envExampleExists = fileExists(envExamplePath)

  const envKeys = envExists ? parseDotEnvKeys(fs.readFileSync(envPath, 'utf8')) : []
  const exKeys = envExampleExists ? parseDotEnvKeys(fs.readFileSync(envExamplePath, 'utf8')) : []

  const envKeySet = new Set(envKeys)
  const exKeySet = new Set(exKeys)

  const missingInExample = envKeys.filter((key) => !exKeySet.has(key))
  const extraInExample = exKeys.filter((key) => !envKeySet.has(key))

  return {
    env: { exists: envExists, readableByAgent: false, keyCount: envKeys.length, keysSample: envKeys.slice(0, 25) },
    envExample: {
      exists: envExampleExists,
      readableByAgent: true,
      keyCount: exKeys.length,
      keysSample: exKeys.slice(0, 25),
    },
    sync: {
      // "Synced" means: every key in .env is present in .env.example.
      synced: envExists ? missingInExample.length === 0 : true,
      missingInExampleCount: missingInExample.length,
      missingInExampleSample: missingInExample.slice(0, 50),
      extraInExampleCount: extraInExample.length,
      extraInExampleSample: extraInExample.slice(0, 50),
    },
    note:
      '.env values are treated as secrets and are never returned. Use .env.example as the env contract. ' +
      (envExists ? '.env exists but is not readable by the agent.' : 'No .env file found.'),
  }
}

export function secretsReadEnvExampleAction(context: ProjectActionContext) {
  const envPath = path.join(context.params.workspaceRoot, '.env')
  const envExamplePath = path.join(context.params.workspaceRoot, '.env.example')
  const envExists = fileExists(envPath)
  const envExampleExists = fileExists(envExamplePath)
  const content = envExampleExists ? fs.readFileSync(envExamplePath, 'utf8') : ''

  return {
    env: { exists: envExists, readableByAgent: false },
    envExample: { exists: envExampleExists, readableByAgent: true, path: '.env.example', content },
    note:
      '.env is treated as secrets and is not readable by the agent. ' +
      (envExists ? '.env exists (hidden).' : '.env not found.') +
      ' .env.example is safe to read and should document required keys.',
  }
}

export function secretsSyncEnvExampleAction(
  context: ProjectActionContext,
  input: ProjectActionInputByAction<'secrets_sync_env_example'>
) {
  const envPath = path.join(context.params.workspaceRoot, '.env')
  const envExists = fileExists(envPath)
  if (!envExists) {
    return { ok: false, envExists: false, note: 'No .env file found; nothing to sync.' }
  }

  const envKeys = parseDotEnvKeys(fs.readFileSync(envPath, 'utf8'))
  const recommended: Record<string, string> = input.includeRecommended
    ? {
        DATABASE_URL: 'postgres://USER:PASSWORD@HOST:5432/DB',
        NEXTAUTH_URL: 'http://localhost:3000',
        NEXTAUTH_SECRET: 'changeme',
        GITHUB_ID: '',
        GITHUB_SECRET: '',
        CRON_SECRET: 'changeme',
        CRON_TARGET_URL: 'http://localhost:3000',
      }
    : {}

  const kv: Record<string, string> = { ...recommended }
  for (const key of envKeys) {
    // Never write actual values from .env to .env.example.
    kv[key] = kv[key] ?? ''
  }

  const res = upsertEnvExample(context.params.workspaceRoot, context.params.rollback, kv)
  return {
    ok: true,
    envExists: true,
    synced: true,
    envKeyCount: envKeys.length,
    addedKeys: res.added,
    envExamplePath: res.path,
    note:
      'Synced .env.example to include all keys from .env (values are never copied). ' +
      (input.includeRecommended ? 'Included recommended keys for auth/db/cron.' : ''),
  }
}

export function rollbackListCommitsAction(
  context: ProjectActionContext,
  input: ProjectActionInputByAction<'rollback_list_commits'>
) {
  return listRollbackCommits({
    workspaceRoot: context.params.workspaceRoot,
    limit: input.limit,
  })
}

export function rollbackRunAction(
  context: ProjectActionContext,
  input: ProjectActionInputByAction<'rollback_run'>
) {
  return rollbackToCommit({
    workspaceRoot: context.params.workspaceRoot,
    commitSha: input.commitSha,
  })
}

export function validateEnvAction(context: ProjectActionContext) {
  const required: Record<string, string> = {
    DATABASE_URL: 'postgres://USER:PASSWORD@HOST:5432/DB',
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXTAUTH_SECRET: 'changeme',
    GITHUB_ID: '',
    GITHUB_SECRET: '',
    CRON_SECRET: 'changeme',
    CRON_TARGET_URL: 'http://localhost:3000',
  }
  return upsertEnvExample(context.params.workspaceRoot, context.params.rollback, required)
}
