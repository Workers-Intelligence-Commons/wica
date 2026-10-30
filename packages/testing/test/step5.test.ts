// Porte de l'étape 5 : un serveur MCP configuré par
// l'hôte se connecte, expose ses outils et se reconnecte après une coupure ; `authorize` voit
// les annotations ; une demande d'information du serveur passe par la personne ; un skill fourni
// par l'hôte se charge à la demande. Le serveur MCP est celui du SDK officiel, relié en mémoire.

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

/** Un serveur MCP neuf par connexion ; `cut` coupe la connexion en cours. */
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
    const timer = setTimeout(() => reject(new Error('délai dépassé')), 3000)
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

describe('étape 5', () => {
  it('expose les outils MCP avec leurs annotations et se reconnecte après une coupure', async () => {
    const server = mcpServer((mcp) => {
      mcp.registerTool(
        'lookup',
        {
          description: 'Cherche une note.',
          inputSchema: z.object({ query: z.string() }),
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        async ({ query }) => ({ content: [{ type: 'text', text: `Note sur ${query}.` }] }),
      )
      mcp.registerTool(
        'delete_note',
        { description: 'Supprime une note.', inputSchema: z.object({ id: z.string() }) },
        async ({ id }) => ({ content: [{ type: 'text', text: `Note ${id} supprimée.` }] }),
      )
    })
    const mcp = await connectMcp([{ name: 'notes', transport: server.transport }])
    expect(mcp.tools().map((t) => t.spec.name)).toEqual(['notes__lookup', 'notes__delete_note'])

    const seen: AuthorizeCall[] = []
    const authorize: Authorize = (call) => {
      seen.push(call)
      return call.annotations.destructiveHint ? { ask: `Autoriser ${call.tool} ?` } : 'allow'
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
        // La connexion tombe entre deux appels : le suivant doit la rouvrir.
        server.cut()
        return {
          parts: [
            { type: 'tool_call', callId: 'k2', tool: 'notes__delete_note', input: { id: 'n1' } },
          ],
        }
      }
      return { parts: [{ type: 'text', text: 'Fin.' }] }
    })
    const { harness, client } = await setup({ model, tools: () => mcp.tools(), authorize })

    await client.send('c1', 'Cherche Paris puis supprime la note n1')
    await waitFor(client, () => client.view('c1').waiting.length > 0)
    expect(client.view('c1').waiting[0]).toMatchObject({
      tool: 'approve',
      input: { question: 'Autoriser notes__delete_note ?' },
    })
    await client.answer('c1', client.view('c1').waiting[0]!.callId, true)
    await waitFor(client, finished(client, 'Fin.'))

    // `authorize` reçoit les annotations du serveur, et les valeurs par défaut de MCP sinon.
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
    expect([textOf(lookup), textOf(deletion)]).toEqual(['Note sur Paris.', 'Note n1 supprimée.'])
    expect([lookup?.isError, deletion?.isError]).not.toContain(true)
    // Un outil ouvert sur le monde extérieur marque son résultat comme non fiable.
    expect(deletion?.meta).toMatchObject({ untrusted: true })
    expect(journalViolations(items)).toEqual([])
    await client.close()
    await mcp.close()
  })

  it('rend un résultat d’erreur quand la connexion tombe pendant un appel, sans faire échouer le tour', async () => {
    const server = mcpServer((mcp, cut) => {
      mcp.registerTool(
        'slow',
        { description: 'Ne répond jamais.', inputSchema: z.object({}) },
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
        : { parts: [{ type: 'text', text: 'Le serveur ne répond plus.' }] },
    )
    const { harness, client } = await setup({ model, tools: () => mcp.tools() })

    await client.send('c1', 'Lance slow')
    await waitFor(client, finished(client, 'Le serveur ne répond plus.'))
    const [result] = results((await harness.store.load('c1', 0)).items)
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('notes/slow')
    await client.close()
    await mcp.close()
  })

  it('reprend un serveur injoignable au démarrage dès qu’il répond', async () => {
    const server = mcpServer((mcp) => {
      mcp.registerTool(
        'lookup',
        { description: 'Cherche.', inputSchema: z.object({}) },
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
          if (!up) throw new Error('serveur arrêté')
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

  it('fait passer une demande d’information du serveur par la personne', async () => {
    const server = mcpServer((mcp) => {
      mcp.registerTool(
        'book',
        { description: 'Réserve un billet.', inputSchema: z.object({}) },
        async (_input, ctx) => {
          const answer = await ctx.mcpReq.elicitInput({
            message: 'Vers quelle ville ?',
            requestedSchema: {
              type: 'object',
              properties: { ville: { type: 'string' } },
              required: ['ville'],
            },
          })
          const city = answer.action === 'accept' ? String(answer.content?.['ville'] ?? '') : ''
          return { content: [{ type: 'text', text: city ? `Billet pour ${city}.` : 'Annulé.' }] }
        },
      )
    })
    const mcp = await connectMcp([{ name: 'notes', transport: server.transport }])
    const model = scriptedModel((request) =>
      results(request.path).some((r) => r.callId === 'k1')
        ? { parts: [{ type: 'text', text: 'Réservé.' }] }
        : { parts: [{ type: 'tool_call', callId: 'k1', tool: 'notes__book', input: {} }] },
    )
    const { harness, client } = await setup({ model, tools: () => mcp.tools(), renderAnswer })

    await client.send('c1', 'Réserve un billet')
    await waitFor(client, () => client.view('c1').waiting.length > 0)
    const [question] = client.view('c1').waiting
    expect(question).toMatchObject({
      tool: 'elicit',
      input: { server: 'notes', message: 'Vers quelle ville ?' },
    })
    await client.answer('c1', question!.callId, { action: 'accept', content: { ville: 'Lyon' } })
    await waitFor(client, finished(client, 'Réservé.'))

    const items = (await harness.store.load('c1', 0)).items
    const answer = results(items).find((r) => r.callId === question!.callId)
    // La réponse compte comme la parole de la personne, dans ses mots.
    expect(answer).toMatchObject({ as: 'user', output: [{ type: 'text', text: 'ville : Lyon' }] })
    expect(textOf(results(items).find((r) => r.callId === 'k1'))).toBe('Billet pour Lyon.')
    expect(journalViolations(items)).toEqual([])
    await client.close()
    await mcp.close()
  })

  it('charge un skill fourni par l’hôte quand la tâche y correspond', async () => {
    const files: Record<string, string> = {
      'skills/releases/SKILL.md':
        '---\nname: releases\ndescription: Prépare une publication.\n---\nÉtape 1 : relire le journal.',
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
        : { parts: [{ type: 'text', text: 'Je relis le journal.' }] },
    )
    const { client } = await setup({ model, skills, instructions: 'Tu aides à publier.' })

    await client.send('c1', 'Prépare la publication')
    await waitFor(client, finished(client, 'Je relis le journal.'))
    const [first, second] = model.requests
    // Au démarrage, le modèle ne voit que le nom et la description ; le corps vient au chargement.
    expect(first?.instructions).toContain('Tu aides à publier.')
    expect(first?.instructions).toContain('- releases : Prépare une publication.')
    expect(first?.instructions).not.toContain('Étape 1')
    expect(first?.tools.map((t) => t.name)).toContain('load_skill')
    expect(textOf(results(second!.path)[0])).toBe('Étape 1 : relire le journal.')
    await client.close()
  })
})
