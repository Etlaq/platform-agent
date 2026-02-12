import 'dotenv/config'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

async function main() {
  await Template.build(template, 'e2b-sandbox-nextjs-dev', {
    memoryMB: 4096,
    cpuCount: 2,
    onBuildLogs: defaultBuildLogger(),
  });
}

main().catch(console.error);