// Porte de l'étape 8 (specs/harness.md, Livraison par étapes) : une session ACP pilote le même
// cœur que le web et le CLI. L'éditeur est simulé dans le processus par le SDK ACP : il fournit
// ses fichiers comme outils, répond à l'approbation, et un client web voit la même conversation.

import * as acp from '@agentclientprotocol/sdk'
import { acpAgent, editorTools } from '@wica/acp'
import { createClient, deriveView } from '@wica/client'
import { journalViolations } from '@wica/core'
import { createHarness, type Authorize, type Tool } from '@wica/runtime'
import { memoryTransportPair } from '@wica/transport-memory'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

const askForDestructive: Authorize = (call) =>
  call.annotations.destructiveHint ? { ask: `Autoriser ${call.tool} ?` } : 'allow'

/** Lit notes.txt par l'éditeur, l'écrit en majuscules, puis conclut. */
const upperModel = () =>
  scriptedModel((request) => {
    const result = (callId: string) =>
      request.path.find((i) => i.kind === 'tool_result' && i.callId === callId)
    const read = result('r1')
    if (read?.kind !== 'tool_result') {
      return {
        parts: [
          { type: 'tool_call', callId: 'r1', tool: 'read_text_file', input: { path: 'notes.txt' } },
        ],
      }
    }
    const write = result('w1')
    if (write?.kind !== 'tool_result') {
      const text = read.output[0]?.type === 'text' ? read.output[0].text : ''
      return {
        parts: [
          {
            type: 'tool_call',
            callId: 'w1',
            tool: 'write_text_file',
            input: { path: 'notes.txt', content: text.toUpperCase() },
          },
        ],
      }
    }
    return { parts: [{ type: 'text', text: write.isError ? 'Refusé.' : 'Fini.' }] }
  })

async function setup(choice: 'allow' | 'reject') {
  // Outils de chaque conversation : ceux que l'éditeur de sa session fournit.
  const tools = new Map<string, Tool[]>()
  const harness = createHarness({
    model: upperModel(),
    tools: (conversationId) => tools.get(conversationId) ?? [],
    authorize: askForDestructive,
    policy: { freeText: 'direct' },
  })
  const connect = async () => {
    const { client, server } = memoryTransportPair()
    void harness.serve(server)
    const wica = createClient(client, { from: { channel: 'local' } })
    await wica.connect()
    return wica
  }
  const wica = await connect()
  const agent = acpAgent({
    client: wica,
    onSession: (session) =>
      void tools.set(session.conversationId, editorTools(session.capabilities)),
  })

  // L'éditeur : un fichier ouvert, et le journal de ce qu'il a reçu, dans l'ordre.
  const files = new Map([['/projet/notes.txt', 'acheter du pain']])
  const log: string[] = []
  const chunks: string[] = []
  const statuses = new Map<string, string>()
  const editor = acp
    .client({ name: 'éditeur' })
    .onRequest('fs/read_text_file', ({ params }) => {
      log.push(`lecture ${params.path}`)
      return { content: files.get(params.path) ?? '' }
    })
    .onRequest('fs/write_text_file', ({ params }) => {
      log.push(`écriture ${params.path}`)
      files.set(params.path, params.content)
      return {}
    })
    .onRequest('session/request_permission', ({ params }) => {
      log.push(`permission ${params.toolCall.toolCallId}`)
      const option = params.options.find((o) => o.kind === `${choice}_once`)
      return { outcome: { outcome: 'selected', optionId: option?.optionId ?? '' } }
    })
    .onNotification('session/update', ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        chunks.push(update.content.text)
      } else if (update.sessionUpdate === 'tool_call') {
        log.push(`appel ${update.toolCallId}`)
        statuses.set(update.toolCallId, update.status ?? '')
      } else if (update.sessionUpdate === 'tool_call_update') {
        statuses.set(update.toolCallId, update.status ?? '')
      }
    })
  const connection = editor.connect(agent)
  const capabilities: acp.ClientCapabilities = {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
  }
  await connection.agent.request('initialize', {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: capabilities,
  })
  const { sessionId } = await connection.agent.request('session/new', {
    cwd: '/projet',
    mcpServers: [],
  })
  return { harness, connect, wica, connection, sessionId, files, log, chunks, statuses }
}

describe('étape 8', () => {
  it('une session ACP pilote le cœur : outils de l’éditeur, approbation, même vue que le web', async () => {
    const { harness, connect, wica, connection, sessionId, files, log, chunks, statuses } =
      await setup('allow')
    const web = await connect()
    await web.subscribe(sessionId)

    const response = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Mets notes.txt en majuscules.' }],
    })

    expect(response.stopReason).toBe('end_turn')
    expect(files.get('/projet/notes.txt')).toBe('ACHETER DU PAIN')
    // L'éditeur connaît chaque appel avant d'avoir à l'exécuter ou à l'autoriser.
    expect(log).toEqual([
      'appel r1',
      'lecture /projet/notes.txt',
      'appel w1',
      'permission w1',
      'écriture /projet/notes.txt',
    ])
    expect(Object.fromEntries(statuses)).toEqual({ r1: 'completed', w1: 'completed' })
    expect(chunks.join('')).toBe('Fini.')

    const { items, head } = await harness.store.load(sessionId, 0)
    expect(journalViolations(items)).toEqual([])
    const expected = deriveView(items, head).entries
    expect(wica.view(sessionId).entries).toEqual(expected)
    await expect.poll(() => web.view(sessionId).entries, { timeout: 2000 }).toEqual(expected)
    connection.close()
    await web.close()
    await wica.close()
  })

  it('un refus dans l’éditeur laisse le fichier intact', async () => {
    const { wica, connection, sessionId, files, log, chunks } = await setup('reject')

    const response = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Mets notes.txt en majuscules.' }],
    })

    expect(response.stopReason).toBe('end_turn')
    expect(files.get('/projet/notes.txt')).toBe('acheter du pain')
    expect(log).not.toContain('écriture /projet/notes.txt')
    expect(chunks.join('')).toBe('Refusé.')
    connection.close()
    await wica.close()
  })
})
