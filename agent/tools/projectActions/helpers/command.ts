import { spawn } from 'node:child_process'

export function safePackageName(name: string) {
  // npm package name (approx), no spaces or shell metacharacters
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)
}

export function safeVersionRange(range: string) {
  // Conservative: allow common semver/range chars only.
  return /^[0-9A-Za-z.+*^~<>=| -]+$/.test(range) && range.length <= 64
}

export async function runCmd(args: string[], cwd: string, timeoutMs = 10 * 60 * 1000) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    proc.once('error', (error) => reject(error))

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => {
        if (proc.exitCode == null) proc.kill('SIGKILL')
      }, 1000)
    }, timeoutMs)

    proc.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}
