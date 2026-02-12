import path from 'node:path'
import { runCmd, safePackageName, safeVersionRange } from '../helpers/command'
import { fileExists, readJsonFile, writeJsonFile } from '../helpers/fileSystem'
import type { ProjectActionInputByAction } from '../schemas'
import type { ProjectActionContext } from '../types'

interface PackageJsonShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

export async function addDependenciesAction(
  context: ProjectActionContext,
  input: ProjectActionInputByAction<'add_dependencies'>
) {
  const pkgPath = path.join(context.params.workspaceRoot, 'package.json')
  const pkg = readJsonFile<PackageJsonShape>(pkgPath)
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.devDependencies = pkg.devDependencies ?? {}

  const depsArgs: string[] = []
  const devArgs: string[] = []

  for (const dep of input.deps) {
    if (!safePackageName(dep.name)) {
      throw new Error(`Invalid package name: ${dep.name}`)
    }
    if (dep.version && !safeVersionRange(dep.version)) {
      throw new Error(`Invalid version range for ${dep.name}: ${dep.version}`)
    }

    const spec = dep.version ? `${dep.name}@${dep.version}` : dep.name
    if (dep.dev) {
      pkg.devDependencies[dep.name] = dep.version ?? 'latest'
      devArgs.push(spec)
    } else {
      pkg.dependencies[dep.name] = dep.version ?? 'latest'
      depsArgs.push(spec)
    }
  }

  context.params.rollback.recordBeforeChange(pkgPath, context.params.workspaceRoot)
  writeJsonFile(pkgPath, pkg)

  const installs: Array<{ cmd: string[]; exitCode: number; stdout: string; stderr: string }> = []
  if ((input.runInstall || context.params.allowHostInstalls) && context.params.allowHostInstalls) {
    if (depsArgs.length) {
      const result = await runCmd(['bun', 'add', ...depsArgs], context.params.workspaceRoot)
      installs.push({ cmd: ['bun', 'add', ...depsArgs], ...result })
    }
    if (devArgs.length) {
      const result = await runCmd(['bun', 'add', '-d', ...devArgs], context.params.workspaceRoot)
      installs.push({ cmd: ['bun', 'add', '-d', ...devArgs], ...result })
    }
  }

  return {
    updated: { packageJson: 'package.json' },
    installs,
    note: context.params.allowHostInstalls
      ? 'Dependencies updated; install attempted.'
      : 'Dependencies updated. Set ALLOW_HOST_INSTALLS=true to let the agent run bun add/install.',
  }
}

export function runInstallAction(context: ProjectActionContext) {
  if (!context.params.allowHostInstalls) {
    return { ok: false, note: 'Set ALLOW_HOST_INSTALLS=true to allow bun install.' }
  }
  return runCmd(['bun', 'install'], context.params.workspaceRoot)
}

export function runNextBuildAction(context: ProjectActionContext) {
  if (!context.params.allowHostInstalls) {
    return { ok: false, note: 'Set ALLOW_HOST_INSTALLS=true to allow running build.' }
  }
  return runCmd(['bunx', '--bun', 'next', 'build'], context.params.workspaceRoot)
}

export function runTypecheckAction(context: ProjectActionContext) {
  if (!context.params.allowHostInstalls) {
    return { ok: false, note: 'Set ALLOW_HOST_INSTALLS=true to allow running typecheck.' }
  }
  if (!fileExists(path.join(context.params.workspaceRoot, 'tsconfig.json'))) {
    return { ok: false, note: 'No tsconfig.json found.' }
  }
  return runCmd(['bunx', 'tsc', '-p', 'tsconfig.json'], context.params.workspaceRoot)
}

export function generateDrizzleMigrationAction(
  context: ProjectActionContext,
  input: ProjectActionInputByAction<'generate_drizzle_migration'>
) {
  if (!context.params.allowHostInstalls) {
    return { ok: false, note: 'Set ALLOW_HOST_INSTALLS=true to allow generating migrations.' }
  }

  const safeName = input.name.replace(/[^A-Za-z0-9_-]/g, '-')
  return runCmd(
    ['bunx', 'drizzle-kit', 'generate', '--name', safeName, '--config', 'drizzle.config.ts'],
    context.params.workspaceRoot
  )
}
