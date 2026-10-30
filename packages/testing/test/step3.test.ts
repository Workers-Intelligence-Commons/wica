// Porte de l'étape 3 (specs/harness.md, Livraison par étapes) : une tâche à plusieurs outils
// menée par le Harness à travers `model-compat` et `codecs`, devant un faux service Open Responses
// qui rejoue un scénario ; la réponse de la personne est rendue en Open Responses.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '@wica/client'
import { USER_REPLY_ACK } from '@wica/codecs'
import { journalViolations } from '@wica/core'
import { ModelError, openResponsesModel } from '@wica/model-compat'
import { allowAll, createHarness } from '@wica/runtime'
import { nodeTools } from '@wica/tools-node'
import { renderAnswer, userTools } from '@wica/tools-user'
import { memoryTransportPair } from '@wica/transport-memory'
import { describe, expect, it } from 'vite-plus/test'

import { openResponsesCall, openResponsesMessage, openResponsesStream } from '../src/index.ts'

type Body = {
  input: { type: string; role?: string; call_id?: string; output?: unknown; content?: unknown }[]
  store: boolean
}
/** Faux service : la réponse dépend du nombre de résultats d'outils déjà reçus. */
function fakeService() {
  const bodies: Body[] = []
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Body
    bodies.push(body)
    const outputs = body.input.filter((i) => i.type === 'function_call_output').length
    if (outputs === 0) {
      return openResponsesStream([
        {
          type: 'reasoning',
          id: 'rs',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Lire puis demander.' }],
          encrypted_content: 'E1',
        },
        openResponsesCall('k1', 'read_file', { path: 'notes.txt' }),
        openResponsesCall('k2', 'ask_user', { kind: 'confirm', question: 'Écrire todo.txt ?' }),
      ])
    }
    if (outputs === 2) {
      const read = body.input.find((i) => i.type === 'function_call_output' && i.call_id === 'k1')
      const content = (read?.output as { text: string }[] | undefined)?.[0]?.text
      return openResponsesStream([
        openResponsesCall('k3', 'write_file', { path: 'todo.txt', content }),
      ])
    }
    if (outputs === 3)
      return openResponsesStream([openResponsesCall('k4', 'say', { text: "C'est fait." })])
    return openResponsesStream([openResponsesMessage('Fin.')])
  }
  return { bodies, fetch: fetch as typeof globalThis.fetch }
}

describe('étape 3', () => {
  it('mène une tâche à plusieurs outils à travers model-compat, avec une réponse de la personne', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wica-step3-'))
    await writeFile(join(dir, 'notes.txt'), 'acheter du pain')
    const service = fakeService()
    const harness = createHarness({
      model: openResponsesModel({
        baseUrl: 'http://service/v1',
        model: 'wpt',
        fetch: service.fetch,
      }),
      tools: [...nodeTools({ roots: [dir] }), ...userTools],
      authorize: allowAll,
      renderAnswer,
      instructions: 'Tu aides à ranger des fichiers.',
    })
    const { client: end, server } = memoryTransportPair()
    void harness.serve(server)
    const client = createClient(end, { from: { channel: 'local' } })
    await client.connect()
    await client.subscribe('c1')

    const changed = (ready: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('délai dépassé')), 2000)
        const check = () => {
          if (!ready()) return
          clearTimeout(timer)
          off()
          resolve()
        }
        const off = client.onChange('c1', check)
        check()
      })

    await client.send('c1', 'Copie notes.txt dans todo.txt')
    await changed(() => client.view('c1').waiting.length > 0)
    const [question] = client.view('c1').waiting
    expect(question).toMatchObject({ tool: 'ask_user', input: { kind: 'confirm' } })
    await client.answer('c1', question!.callId, { kind: 'confirm', yes: true })

    await changed(() =>
      client.view('c1').entries.some((e) => e.type === 'assistant' && e.text === 'Fin.'),
    )
    expect(await readFile(join(dir, 'todo.txt'), 'utf8')).toBe('acheter du pain')

    // La réponse de la personne : un résultat minimal, puis sa parole en tour utilisateur.
    const second = service.bodies[1]!
    const tail = second.input.slice(-3)
    expect(tail).toEqual([
      {
        type: 'function_call_output',
        call_id: 'k1',
        output: [{ type: 'input_text', text: 'acheter du pain' }],
      },
      {
        type: 'function_call_output',
        call_id: 'k2',
        output: [{ type: 'input_text', text: USER_REPLY_ACK }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Oui.' }] },
    ])
    // Le raisonnement chiffré revient au même fournisseur ; aucun état n'est gardé chez lui.
    expect(second.input).toContainEqual({ type: 'reasoning', summary: [], encrypted_content: 'E1' })
    expect(service.bodies.every((b) => b.store === false)).toBe(true)
    expect(service.bodies).toHaveLength(4)

    const view = client.view('c1')
    expect(view.entries.map((e) => e.type)).toEqual([
      'user',
      'tool',
      'question',
      'tool',
      'say',
      'assistant',
    ])
    expect(view.entries.find((e) => e.type === 'say')).toMatchObject({ text: "C'est fait." })
    expect(journalViolations((await harness.store.load('c1', 0)).items)).toEqual([])
    await client.close()
  })

  it('réessaie un service passagèrement indisponible, puis signale un refus définitif', async () => {
    let calls = 0
    const flaky = (async () => {
      calls += 1
      return calls === 1
        ? new Response('occupé', { status: 503 })
        : openResponsesStream([openResponsesMessage('Bonjour.')])
    }) as typeof fetch
    const ok = openResponsesModel({ baseUrl: 'http://s/v1', model: 'm', fetch: flaky })
    const chunks = []
    for await (const c of ok.stream(
      { trigger: 'u', path: [], tools: [] },
      new AbortController().signal,
    ))
      chunks.push(c)
    expect(calls).toBe(2)
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      message: { parts: [{ type: 'text', text: 'Bonjour.' }] },
    })

    const refused = (async () =>
      new Response(
        JSON.stringify({ error: { message: 'modèle inconnu', code: 'model_not_found' } }),
        { status: 404 },
      )) as typeof fetch
    const harness = createHarness({
      model: openResponsesModel({ baseUrl: 'http://s/v1', model: 'm', fetch: refused }),
      authorize: allowAll,
    })
    const seen: string[] = []
    for await (const event of harness.run('Bonjour', { conversationId: 'e1' })) {
      if (event.type === 'error') seen.push(event.message)
    }
    expect(seen).toEqual(['modèle inconnu'])
    const bad = openResponsesModel({ baseUrl: 'http://s/v1', model: 'm', fetch: refused })
    await expect(
      (async () => {
        for await (const _ of bad.stream(
          { trigger: 'u', path: [], tools: [] },
          new AbortController().signal,
        ))
          void _
      })(),
    ).rejects.toBeInstanceOf(ModelError)
  })
})
