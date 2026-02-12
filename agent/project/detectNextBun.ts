import fs from 'node:fs'
import path from 'node:path'

export type NextRouterMode = 'app' | 'pages' | 'unknown'

export interface NextBunDetection {
  workspaceRoot: string
  isNext: boolean
  isBun: boolean
  router: NextRouterMode
  usesSrcDir: boolean
  isTypeScript: boolean
  packageJson?: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string }
}

function fileExists(p: string) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function readJson<T>(p: string): T | null {
  try {
    const raw = fs.readFileSync(p, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function detectNextBun(workspaceRoot: string): NextBunDetection {
  const pkgPath = path.join(workspaceRoot, 'package.json')
  const pkg = readJson<NextBunDetection['packageJson']>(pkgPath) ?? undefined

  const deps = pkg?.dependencies ?? {}
  const devDeps = pkg?.devDependencies ?? {}
  const isNext = Boolean(deps.next || devDeps.next)

  const hasBunLock = fileExists(path.join(workspaceRoot, 'bun.lockb')) || fileExists(path.join(workspaceRoot, 'bun.lock'))
  const pkgManager = (pkg?.packageManager ?? '').toLowerCase()
  const isBun = hasBunLock || pkgManager.startsWith('bun@')

  const srcApp = fileExists(path.join(workspaceRoot, 'src', 'app'))
  const srcPages = fileExists(path.join(workspaceRoot, 'src', 'pages'))
  const app = fileExists(path.join(workspaceRoot, 'app')) || srcApp
  const pages = fileExists(path.join(workspaceRoot, 'pages')) || srcPages

  const router: NextRouterMode = app ? 'app' : pages ? 'pages' : 'unknown'
  const usesSrcDir = srcApp || srcPages
  const isTypeScript =
    fileExists(path.join(workspaceRoot, 'tsconfig.json')) ||
    Boolean(deps.typescript || devDeps.typescript)

  return {
    workspaceRoot,
    isNext,
    isBun,
    router,
    usesSrcDir,
    isTypeScript,
    packageJson: pkg,
  }
}

