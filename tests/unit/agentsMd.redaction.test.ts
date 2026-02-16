import { describe, expect, it } from 'bun:test'

import { NOTES_END, NOTES_START, appendAgentsNote } from '../../agent/agentsMd'

class MemoryBackend {
  private files = new Map<string, string>()

  constructor(seed?: Record<string, string>) {
    if (seed) {
      for (const [k, v] of Object.entries(seed)) this.files.set(k, v)
    }
  }

  async readRaw(filePath: string): Promise<{ content?: string[] }> {
    const v = this.files.get(filePath)
    if (v == null) throw new Error('not found')
    return { content: v.split('\n') }
  }

  async write(filePath: string, content: string): Promise<{ error?: string }> {
    this.files.set(filePath, content)
    return {}
  }

  async edit(
    filePath: string,
    oldContent: string,
    newContent: string,
    _dryRun: boolean,
  ): Promise<{ error?: string }> {
    const current = this.files.get(filePath)
    if (current != null && current !== oldContent) {
      return { error: 'stale_edit' }
    }
    this.files.set(filePath, newContent)
    return {}
  }

  get(filePath: string) {
    return this.files.get(filePath)
  }
}

describe('agent/agentsMd redactLikelySecrets', () => {
  it('redacts common API key/token patterns before appending notes', async () => {
    const secretZai = 'a87f5582735545d5a05aea955df87368.QgR1hSmMk3zHcCud'
    const secretBearer = 'Bearer abcdefghijklmnopqrstuvwxyz.0123456789_ABCDEFG'

    const backend = new MemoryBackend({
      '/AGENTS.md': `# AGENTS.md\n\n## Notes (Append Only)\n${NOTES_START}\n${NOTES_END}\n`,
    })

    await appendAgentsNote({
      // Cast is fine here: we only use the subset of the protocol needed by agentsMd.
      backend: backend as unknown as Parameters<typeof appendAgentsNote>[0]['backend'],
      note: `tool=sandbox_cmd | input=ZAI_API_KEY=${secretZai} Authorization: ${secretBearer} raw=${secretZai}`,
      filePath: '/AGENTS.md',
    })

    const updated = backend.get('/AGENTS.md') ?? ''
    expect(updated).not.toContain(secretZai)
    expect(updated).not.toContain(secretBearer)
    expect(updated).toContain('<redacted>')
  })
})

