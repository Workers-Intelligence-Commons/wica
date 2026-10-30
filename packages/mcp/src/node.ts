// Lancement de serveurs MCP locaux (stdio), propre à Node : le reste du paquet n'utilise que des
// API web standard.

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export type StdioServer = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

/** Fabrique de transport pour `McpServerConfig.transport` : un nouveau processus par connexion. */
export const stdioServer =
  (server: StdioServer): (() => Transport) =>
  () =>
    new StdioClientTransport({
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.env ? { env: server.env } : {}),
      stderr: 'pipe',
    })
