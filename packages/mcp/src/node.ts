// Launching local MCP servers (stdio), specific to Node: the rest of the package uses only
// standard web APIs.

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export type StdioServer = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

/** Transport factory for `McpServerConfig.transport`: a new process per connection. */
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
