// template.ts
import { Template, waitForURL } from 'e2b'

export const template = Template()
  .fromBunImage('1.3')
  // Ensure git is available for cloning the template repo.
  .runCmd(
    'bash -lc "command -v git >/dev/null || (apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*)"',
    { user: 'root' }
  )
  .setWorkdir('/home/user')
  .runCmd('git clone https://github.com/Etlaq/etlaq-nextjs-template.git /tmp/etlaq-template')
  .runCmd(
    "bash -lc 'shopt -s dotglob; mv /tmp/etlaq-template/* /home/user/ && rm -rf /tmp/etlaq-template'"
  )
  .runCmd('bun install')
  .runCmd('mkdir -p /home/user/uploads')
  .runCmd('git config --global user.email "omar@etlaq.sa" && git config --global user.name "etlaq studio"')
  .setStartCmd('bun run dev --turbo', waitForURL('http://localhost:3000'))
