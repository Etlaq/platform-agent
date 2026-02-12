import fs from 'node:fs'
import path from 'node:path'
import { MultiServerMCPClient } from '@langchain/mcp-adapters'

export function loadMcpConfig(): Record<string, unknown> | null {
  const inline = process.env.MCP_SERVERS
  const configPath = process.env.MCP_SERVERS_PATH
  if (inline) {
    try {
      return JSON.parse(inline) as Record<string, unknown>
    } catch (err) {
      throw new Error(`Invalid MCP_SERVERS JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (configPath) {
    const resolved = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(process.cwd(), configPath)
    const raw = fs.readFileSync(resolved, 'utf8')
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      throw new Error(`Invalid MCP_SERVERS_PATH JSON (${resolved}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return null
}

export async function loadMcpTools() {
  const rawConfig = loadMcpConfig()
  if (!rawConfig) return { tools: [] as unknown[], client: null as MultiServerMCPClient | null }
  const config = 'mcpServers' in rawConfig
    ? rawConfig
    : { mcpServers: rawConfig }

  const client = new MultiServerMCPClient(config as any)
  try {
    const tools = await client.getTools()
    return { tools, client }
  } catch (err) {
    const closeFn = (client as unknown as { close?: () => Promise<void> }).close
    if (closeFn) {
      try {
        await closeFn.call(client)
      } catch {
        // ignore
      }
    }
    throw err
  }
}
