// Step 8 gate: an ACP session drives the same core as the web and the CLI. The editor is
// simulated in the process by the ACP SDK: it provides its files as tools, answers the approval,
// and a web client sees the same conversation.

import * as acp from '@agentclientprotocol/sdk'
import { acpAgent, editorTools } from '@wica/acp'
import { createClient, deriveView } from '@wica/client'
import { journalViolations } from '@wica/core'
import { createHarness, type Authorize, type Tool } from '@wica/runtime'
import { memoryTransportPair } from '@wica/transport-memory'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

const askForDestructive: Authorize = (call) =>
  call.annotations.destructiveHint ? { ask: `Allow ${call.tool}?` } : 'allow'

/** Reads notes.txt through the editor, writes it in uppercase, then concludes. */
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
    return { parts: [{ type: 'text', text: write.isError ? 'Refused.' : 'Finished.' }] }
  })

async function setup(choice: 'allow' | 'reject') {
  // Tools of each conversation: the ones the editor of its session provides.
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

  // The editor: an open file, and the log of what it received, in order.
  const files = new Map([['/project/notes.txt', 'buy bread']])
  const log: string[] = []
  const chunks: string[] = []
  const statuses = new Map<string, string>()
  const editor = acp
    .client({ name: 'editor' })
    .onRequest('fs/read_text_file', ({ params }) => {
      log.push(`read ${params.path}`)
      return { content: files.get(params.path) ?? '' }
    })
    .onRequest('fs/write_text_file', ({ params }) => {
      log.push(`write ${params.path}`)
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
        log.push(`call ${update.toolCallId}`)
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
    cwd: '/project',
    mcpServers: [],
  })
  return { harness, connect, wica, connection, sessionId, files, log, chunks, statuses }
}

describe('step 8', () => {
  it('an ACP session drives the core: editor tools, approval, same view as the web', async () => {
    const { harness, connect, wica, connection, sessionId, files, log, chunks, statuses } =
      await setup('allow')
    const web = await connect()
    await web.subscribe(sessionId)

    const response = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Put notes.txt in uppercase.' }],
    })

    expect(response.stopReason).toBe('end_turn')
    expect(files.get('/project/notes.txt')).toBe('BUY BREAD')
    // The editor knows each call before it has to run or allow it.
    expect(log).toEqual([
      'call r1',
      'read /project/notes.txt',
      'call w1',
      'permission w1',
      'write /project/notes.txt',
    ])
    expect(Object.fromEntries(statuses)).toEqual({ r1: 'completed', w1: 'completed' })
    expect(chunks.join('')).toBe('Finished.')

    const { items, head } = await harness.store.load(sessionId, 0)
    expect(journalViolations(items)).toEqual([])
    const expected = deriveView(items, head).entries
    expect(wica.view(sessionId).entries).toEqual(expected)
    await expect.poll(() => web.view(sessionId).entries, { timeout: 2000 }).toEqual(expected)
    connection.close()
    await web.close()
    await wica.close()
  })

  it('a refusal in the editor leaves the file intact', async () => {
    const { wica, connection, sessionId, files, log, chunks } = await setup('reject')

    const response = await connection.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Put notes.txt in uppercase.' }],
    })

    expect(response.stopReason).toBe('end_turn')
    expect(files.get('/project/notes.txt')).toBe('buy bread')
    expect(log).not.toContain('write /project/notes.txt')
    expect(chunks.join('')).toBe('Refused.')
    connection.close()
    await wica.close()
  })
})
