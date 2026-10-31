// Step 5 gate: an MCP server configured by the host connects, exposes its tools and reconnects
// after a disconnection; `authorize` sees the annotations; an information request of the server
// goes through the person; a skill provided by the host loads on demand. The MCP server is the
// one from the official SDK, linked in memory.

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { type Client, createClient } from '@wica/client'
import { type Item, journalViolations } from '@wica/core'
import { connectMcp } from '@wica/mcp'
import {
  type Authorize,
  type AuthorizeCall,
  createHarness,
  type HarnessOptions,
} from '@wica/runtime'
import { loadSkills, skillsKit } from '@wica/skills'
import { renderAnswer } from '@wica/tools-user'
import { memoryTransportPair } from '@wica/transport-memory'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'

import { scriptedModel } from '../src/index.ts'

/** A fresh MCP server per connection; `cut` cuts the current connection. */
function mcpServer(register: (server: McpServer, cut: () => void) => void) {
  let current: InMemoryTransport | null = null
  let connections = 0
  const cut = () => void current?.close()
  return {
    get connections() {
      return connections
    },
    cut,
    transport: () => {
      const [client, server] = InMemoryTransport.createLinkedPair()
      const mcp = new McpServer({ name: 'notes', version: '1.0.0' })
      register(mcp, cut)
      void mcp.connect(server)
      current = server
      connections += 1
      return client
    },
  }
}

async function setup(options: HarnessOptions) {
  const harness = createHarness(options)
  const { client: end, server } = memoryTransportPair()
  void harness.serve(server)
  const client = createClient(end, { from: { channel: 'local' } })
  await client.connect()
  await client.subscribe('c1')
  return { harness, client }
}

function waitFor(client: Client, ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 3000)
    const check = () => {
      if (!ready()) return
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = client.onChange('c1', check)
    check()
  })
}

const finished = (client: Client, text: string) => () =>
  client.view('c1').entries.some((e) => e.type === 'assistant' && !e.streaming && e.text === text)

const results = (path: readonly Item[]) =>
  path.filter((i): i is Extract<Item, { kind: 'tool_result' }> => i.kind === 'tool_result')

const textOf = (item: Extract<Item, { kind: 'tool_result' }> | undefined) =>
  item?.output.map((p) => (p.type === 'text' ? p.text : '')).join('')

describe('step 5', () => {
  it('exposes the MCP tools with their annotations and reconnects after a disconnection', async () => {
    const server = mcpServer((mcp) => {
      mcp.registerTool(
        'lookup',
        {
          description: 'Searches for a note.',
          inputSchema: z.object({ query: z.string() }),
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        async ({ query }) => ({ content: [{ type: 'text', text: `Note about ${query}.` }] }),
      )
      mcp.registerTool(
        'delete_note',
        { description: 'Deletes a note.', inputSchema: z.object({ id: z.string() }) },
        async ({ id }) => ({ content: [{ type: 'text', text: `Note ${id} deleted.` }] }),
      )
    })
    const mcp = await connectMcp([{ name: 'notes', transport: server.transport }])
    expect(mcp.tools().map((t) => t.spec.name)).toEqual(['notes__lookup', 'notes__delete_note'])

    const seen: AuthorizeCall[] = []
    const authorize: Authorize = (call) => {
      seen.push(call)
      return call.annotations.destructiveHint ? { ask: `Allow ${call.tool}?` } : 'allow'
    }
    const model = scriptedModel((request) => {
      const done = results(request.path)
      if (done.length === 0) {
        return {
          parts: [
            { type: 'tool_call', callId: 'k1', tool: 'notes__lookup', input: { query: 'Paris' } },
          ],
        }
      }
      if (done.length === 1) {
        // The connection drops between two calls: the next one must reopen it.
        server.cut()
        return {
          parts: [
            { type: 'tool_call', callId: 'k2', tool: 'notes__delete_note', input: { id: 'n1' } },
          ],
        }
      }
      return { parts: [{ type: 'text', text: 'End.' }] }
    })
    const { harness, client } = await setup({ model, tools: () => mcp.tools(), authorize })

    await client.send('c1', 'Search for Paris, then delete note n1')
    await waitFor(client, () => client.view('c1').waiting.length > 0)
    expect(client.view('c1').waiting[0]).toMatchObject({
      tool: 'approve',
      input: { question: 'Allow notes__delete_note?' },
    })
    await client.answer('c1', client.view('c1').waiting[0]!.callId, true)
    await waitFor(client, finished(client, 'End.'))

    // `authorize` receives the annotations of the server, and the MCP default values otherwise.
    expect(seen.map((c) => [c.tool, c.annotations])).toEqual([
      [
        'notes__lookup',
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ],
      [
        'notes__delete_note',
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      ],
    ])
    expect(server.connections).toBe(2)
    const items = (await harness.store.load('c1', 0)).items
    const lookup = results(items).find((r) => r.callId === 'k1')
    const deletion = results(items).find((r) => r.callId === 'k2')
    expect([textOf(lookup), textOf(deletion)]).toEqual(['Note about Paris.', 'Note n1 deleted.'])
    expect([lookup?.isError, deletion?.isError]).not.toContain(true)
    // A tool open on the outside world marks its result as untrusted.
    expect(deletion?.meta).toMatchObject({ untrusted: true })
    expect(journalViolations(items)).toEqual([])
    await client.close()
    await mcp.close()
  })

  it('returns an error result when the connection drops during a call, without making the turn fail', async () => {
    const server = mcpServer((mcp, cut) => {
      mcp.registerTool(
        'slow',
        { description: 'Never answers.', inputSchema: z.object({}) },
        async () => {
          cut()
          return new Promise(() => {})
        },
      )
    })
    const mcp = await connectMcp([{ name: 'notes', transport: server.transport }])
    const model = scriptedModel((request) =>
      results(request.path).length === 0
        ? { parts: [{ type: 'tool_call', callId: 'k1', tool: 'notes__slow', input: {} }] }
        : { parts: [{ type: 'text', text: 'The server no longer answers.' }] },
    )
    const { harness, client } = await setup({ model, tools: () => mcp.tools() })

    await client.send('c1', 'Run slow')
    await waitFor(client, finished(client, 'The server no longer answers.'))
    const [result] = results((await harness.store.load('c1', 0)).items)
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('notes/slow')
    await client.close()
    await mcp.close()
  })

  it('resumes a server unreachable at startup as soon as it answers', async () => {
    const server = mcpServer((mcp) => {
      mcp.registerTool(
        'lookup',
        { description: 'Searches.', inputSchema: z.object({}) },
        async () => ({
          content: [{ type: 'text', text: 'ok' }],
        }),
      )
    })
    let up = false
    const mcp = await connectMcp([
      {
        name: 'notes',
        transport: () => {
          if (!up) throw new Error('server stopped')
          return server.transport()
        },
      },
    ])
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
    expect(mcp.tools()).toEqual([])
    await settle()
    up = true
    mcp.tools()
    await settle()
    expect(mcp.tools().map((t) => t.spec.name)).toEqual(['notes__lookup'])
    await mcp.close()
  })

  it('passes an information request of the server through the person', async () => {
    const server = mcpServer((mcp) => {
      mcp.registerTool(
        'book',
        { description: 'Books a ticket.', inputSchema: z.object({}) },
        async (_input, ctx) => {
          const answer = await ctx.mcpReq.elicitInput({
            message: 'To which city?',
            requestedSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          })
          const city = answer.action === 'accept' ? String(answer.content?.['city'] ?? '') : ''
          return { content: [{ type: 'text', text: city ? `Ticket to ${city}.` : 'Cancelled.' }] }
        },
      )
    })
    const mcp = await connectMcp([{ name: 'notes', transport: server.transport }])
    const model = scriptedModel((request) =>
      results(request.path).some((r) => r.callId === 'k1')
        ? { parts: [{ type: 'text', text: 'Booked.' }] }
        : { parts: [{ type: 'tool_call', callId: 'k1', tool: 'notes__book', input: {} }] },
    )
    const { harness, client } = await setup({ model, tools: () => mcp.tools(), renderAnswer })

    await client.send('c1', 'Book a ticket')
    await waitFor(client, () => client.view('c1').waiting.length > 0)
    const [question] = client.view('c1').waiting
    expect(question).toMatchObject({
      tool: 'elicit',
      input: { server: 'notes', message: 'To which city?' },
    })
    await client.answer('c1', question!.callId, { action: 'accept', content: { city: 'Lyon' } })
    await waitFor(client, finished(client, 'Booked.'))

    const items = (await harness.store.load('c1', 0)).items
    const answer = results(items).find((r) => r.callId === question!.callId)
    // The answer counts as the person's speech, in their words.
    expect(answer).toMatchObject({ as: 'user', output: [{ type: 'text', text: 'city: Lyon' }] })
    expect(textOf(results(items).find((r) => r.callId === 'k1'))).toBe('Ticket to Lyon.')
    expect(journalViolations(items)).toEqual([])
    await client.close()
    await mcp.close()
  })

  it('loads a skill provided by the host when the task matches it', async () => {
    const files: Record<string, string> = {
      'skills/releases/SKILL.md':
        '---\nname: releases\ndescription: Prepares a release.\n---\nStep 1: read the journal again.',
    }
    const read = async (path: string) => files[path] ?? Promise.reject(new Error(path))
    const skills = skillsKit(await loadSkills(['skills/releases'], read), read)
    const model = scriptedModel((request) =>
      results(request.path).length === 0
        ? {
            parts: [
              { type: 'tool_call', callId: 'k1', tool: 'load_skill', input: { name: 'releases' } },
            ],
          }
        : { parts: [{ type: 'text', text: 'Reading the journal again.' }] },
    )
    const { client } = await setup({ model, skills, instructions: 'You help publish.' })

    await client.send('c1', 'Prepare the release')
    await waitFor(client, finished(client, 'Reading the journal again.'))
    const [first, second] = model.requests
    // At startup, the model sees only the name and the description; the body comes at loading.
    expect(first?.instructions).toContain('You help publish.')
    expect(first?.instructions).toContain('- releases: Prepares a release.')
    expect(first?.instructions).not.toContain('Step 1')
    expect(first?.tools.map((t) => t.name)).toContain('load_skill')
    expect(textOf(results(second!.path)[0])).toBe('Step 1: read the journal again.')
    await client.close()
  })
})
