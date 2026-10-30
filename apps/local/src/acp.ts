// Mode ACP du binaire local : l'éditeur lance `wica acp` et parle l'Agent Client Protocol sur
// l'entrée et la sortie standard. Le Harness tourne dans le même processus ; l'adaptateur en est
// un client, comme la ligne de commande. Les fichiers et le terminal sont ceux de l'éditeur, et
// les serveurs MCP que l'éditeur passe à la session s'ajoutent à ses outils.

import { type AcpSession, acpAgent, editorTools } from '@wica/acp'
import { stdioStream } from '@wica/acp/node'
import { createClient } from '@wica/client'
import { connectMcp, type McpServerConfig } from '@wica/mcp'
import { stdioServer } from '@wica/mcp/node'
import type { Tool } from '@wica/runtime'
import { userTools } from '@wica/tools-user'
import { memoryTransportPair } from '@wica/transport-memory'

import { createLocalServer, type LocalConfig } from './server.ts'

const INSTRUCTIONS = `Tu travailles dans un éditeur de code : ses fichiers et son terminal sont tes outils, et les chemins relatifs partent du dossier de travail de la session. Parle à la personne avec l'outil say, et pose tes questions avec ask_user.`

type Mcp = Awaited<ReturnType<typeof connectMcp>>

/** Serveurs MCP de l'éditeur : stdio, que tout agent ACP doit accepter, et HTTP, annoncé. */
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
    // SSE n'est pas annoncé à l'initialisation : l'éditeur ne devrait pas en envoyer.
    process.stderr.write(`wica : serveur MCP ${server.name} ignoré (transport ${server.type}).\n`)
    return []
  })
}

/** Sert une session ACP jusqu'à ce que l'éditeur ferme la connexion. */
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
