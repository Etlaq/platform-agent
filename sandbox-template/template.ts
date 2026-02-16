// template.ts
import { Template, waitForURL } from 'e2b'

export const template = Template({
  fileContextPath: './project',
  fileIgnorePatterns: ['node_modules', '.next'],
})
  .fromBunImage('1.3')
  // Keep git available in the sandbox for repo operations and git config.
  .runCmd(
    `bash -lc 'set -euxo pipefail; \
if ! command -v git >/dev/null; then \
  DEBIAN_FRONTEND=noninteractive apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates; \
  rm -rf /var/lib/apt/lists/*; \
fi; \
git --version'`,
    { user: 'root' }
  )
  .setWorkdir('/home/user')
  .copy('.', '/home/user/')
  .runCmd('bun install')
  // Verify node_modules exists after install.
  .runCmd('ls -la node_modules')
  .runCmd('mkdir -p /home/user/uploads')
  .runCmd('git config --global user.email "omar@etlaq.sa" && git config --global user.name "etlaq studio"')
  .setStartCmd('bun run dev --turbo', waitForURL('http://localhost:3000'))
