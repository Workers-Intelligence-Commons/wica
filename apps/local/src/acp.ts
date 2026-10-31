// ACP mode of the local binary: the editor launches `wica acp` and speaks the Agent Client
// Protocol over standard input and output. The Harness runs in the same process; the adapter is
// one of its clients, like the command line. The files and the terminal are the editor's, and
// the MCP servers the editor passes to the session are added to its tools.

import { type AcpSession, acpAgent, editorTools } from '@wica/acp'
import { stdioStream } from '@wica/acp/node'
import { createClient } from '@wica/client'
import { connectMcp, type McpServerConfig } from '@wica/mcp'
import { stdioServer } from '@wica/mcp/node'
import type { Tool } from '@wica/runtime'
import { userTools } from '@wica/tools-user'
import { memoryTransportPair } from '@wica/transport-memory'

import { createLocalServer, type LocalConfig } from './server.ts'

const INSTRUCTIONS = `You work in a code editor: its files and its terminal are your tools, and relative paths start from the working folder of the session. Speak to the person with the say tool, and ask your questions with ask_user.`

type Mcp = Awaited<ReturnType<typeof connectMcp>>

/** MCP servers of the editor: stdio, which every ACP agent must accept, and HTTP, announced. */
function mcpServers(session: AcpSession): McpServerConfig[] {
  return session.mcpServers.flatMap((server): McpServerConfig[] => {
    if (!('type' in server)) {
      return [
        {
          name: server.name,
          transport: stdioServer({
            command: server.command,
            args: server.args,
            cwd: session.cwd,
            env: Object.fromEntries(server.env.map((v) => [v.name, v.value])),
          }),
        },
      ]
    }
    if (server.type === 'http') {
      return [
        {
          name: server.name,
          url: server.url,
          headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
        },
      ]
    }
    // SSE is not announced at initialization: the editor should not send any.
    process.stderr.write(`wica: MCP server ${server.name} ignored (transport ${server.type}).\n`)
    return []
  })
}

/** Serves an ACP session until the editor closes the connection. */
export async function serveAcp(config: LocalConfig) {
  const sessions = new Map<string, { tools: Tool[]; mcp: Mcp }>()
  const harness = createLocalServer(config, {
    tools: (conversationId) => {
      const session = sessions.get(conversationId)
      if (!session) return userTools
      return [...session.tools, ...session.mcp.tools()]
    },
    instructions: INSTRUCTIONS,
  })
  const { client, server } = memoryTransportPair()
  void harness.serve(server)
  const wica = createClient(client, { from: { channel: 'local' } })
  await wica.connect()
  const connection = acpAgent({
    client: wica,
    agentInfo: { name: 'wica', version: '0.0.0' },
    mcpCapabilities: { http: true },
    onSession: async (session) => {
      await sessions.get(session.conversationId)?.mcp.close()
      sessions.set(session.conversationId, {
        tools: [...editorTools(session.capabilities), ...userTools],
        mcp: await connectMcp(mcpServers(session)),
      })
    },
  }).connect(stdioStream())
  await connection.closed
  await Promise.all([...sessions.values()].map((s) => s.mcp.close()))
  await wica.close()
}
