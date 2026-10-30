// Porte de l'étape 2 (specs/harness.md, Livraison par étapes) : topologie tout-local, un seul
// processus ; un agent mène une tâche sur des fichiers de bout en bout, avec approbations.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Client, createClient } from '@wica/client'
import { journalViolations } from '@wica/core'
import { allowAll, type Authorize, createHarness, type ModelAdapter } from '@wica/runtime'
import { nodeTools } from '@wica/tools-node'
import { memoryTransportPair } from '@wica/transport-memory'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

const askForWrites: Authorize = (call) =>
  call.annotations.readOnlyHint ? 'allow' : { ask: `Autoriser ${call.tool} ?` }

// Le modèle lit notes.txt, l'écrit dans todo.txt, puis conclut ; il s'adapte à un refus.
const copyModel = () =>
  scriptedModel((request) => {
    const last = request.path.findLast((i) => i.kind !== 'event')
    const results = request.path.filter((i) => i.kind === 'tool_result')
    if (last?.kind === 'tool_result' && last.isError) {
      return { parts: [{ type: 'text', text: "D'accord, je n'écris rien." }] }
    }
    if (results.length === 0) {
      return {
        parts: [
          { type: 'text', text: 'Je lis le fichier.' },
          { type: 'tool_call', callId: 'k1', tool: 'read_file', input: { path: 'notes.txt' } },
        ],
      }
    }
    if (results.length === 1) {
      const content =
        last?.kind === 'tool_result' && last.output[0]?.type === 'text' ? last.output[0].text : ''
      return {
        parts: [
          {
            type: 'tool_call',
            callId: 'k2',
            tool: 'write_file',
            input: { path: 'todo.txt', content },
          },
        ],
      }
    }
    return { parts: [{ type: 'text', text: "C'est fait." }] }
  })

async function setup(model: ModelAdapter, authorize: Authorize) {
  const dir = await mkdtemp(join(tmpdir(), 'wica-step2-'))
  await writeFile(join(dir, 'notes.txt'), 'acheter du pain')
  const harness = createHarness({ model, tools: nodeTools({ roots: [dir] }), authorize })
  const { client: clientEnd, server } = memoryTransportPair()
  void harness.serve(server)
  const client = createClient(clientEnd, { from: { channel: 'local' } })
  await client.connect()
  await client.subscribe('c1')
  return { dir, harness, client }
}

function waitFor(client: Client, conversationId: string, ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('délai dépassé')), 2000)
    const check = () => {
      if (!ready()) return
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = client.onChange(conversationId, check)
    check()
  })
}

const finalText = (client: Client) =>
  client
    .view('c1')
    .entries.filter((e) => e.type === 'assistant' && !e.streaming)
    .map((e) => (e.type === 'assistant' ? e.text : ''))
    .at(-1)

describe('étape 2', () => {
  it("mène la tâche de bout en bout quand la personne accorde l'écriture", async () => {
    const { dir, harness, client } = await setup(copyModel(), askForWrites)
    await client.send('c1', 'Copie notes.txt dans todo.txt')

    await waitFor(client, 'c1', () => client.view('c1').waiting.length > 0)
    const [question] = client.view('c1').waiting
    expect(question).toMatchObject({
      tool: 'approve',
      input: { question: 'Autoriser write_file ?' },
    })
    await client.answer('c1', question!.callId, true)

    await waitFor(client, 'c1', () => finalText(client) === "C'est fait.")
    expect(await readFile(join(dir, 'todo.txt'), 'utf8')).toBe('acheter du pain')
    const view = client.view('c1')
    expect(view.entries.map((e) => e.type)).toEqual([
      'user',
      'tool',
      'tool',
      'question',
      'assistant',
    ])
    expect(
      view.entries.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.state),
    ).toEqual(['done', 'done'])
    const items = (await harness.store.load('c1', 0)).items
    expect(journalViolations(items)).toEqual([])
    await client.close()
  })

  it("n'écrit rien quand la personne refuse, et le modèle reçoit le refus", async () => {
    const { dir, harness, client } = await setup(copyModel(), askForWrites)
    await client.send('c1', 'Copie notes.txt dans todo.txt')
    await waitFor(client, 'c1', () => client.view('c1').waiting.length > 0)
    await client.answer('c1', client.view('c1').waiting[0]!.callId, false)

    await waitFor(client, 'c1', () => finalText(client) === "D'accord, je n'écris rien.")
    await expect(readFile(join(dir, 'todo.txt'), 'utf8')).rejects.toThrow()
    const items = (await harness.store.load('c1', 0)).items
    expect(items.find((i) => i.kind === 'tool_result' && i.callId === 'k2')).toMatchObject({
      isError: true,
    })
    expect(journalViolations(items)).toEqual([])
    await client.close()
  })

  it('refuse un chemin hors du dossier autorisé, même quand tout est autorisé', async () => {
    const model = scriptedModel((request) =>
      request.path.some((i) => i.kind === 'tool_result')
        ? { parts: [{ type: 'text', text: 'Fin.' }] }
        : {
            parts: [
              {
                type: 'tool_call',
                callId: 'k1',
                tool: 'read_file',
                input: { path: '../../etc/passwd' },
              },
            ],
          },
    )
    const { harness, client } = await setup(model, allowAll)
    await client.send('c1', 'Lis /etc/passwd')
    await waitFor(client, 'c1', () => finalText(client) === 'Fin.')
    const result = (await harness.store.load('c1', 0)).items.find((i) => i.kind === 'tool_result')
    expect(result).toMatchObject({ isError: true })
    expect(result?.kind === 'tool_result' && result.output[0]).toMatchObject({
      text: expect.stringContaining('Accès refusé'),
    })
    await client.close()
  })

  it('harness.run reste ouvert pendant la question, puis se termine après la réponse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wica-step2-'))
    await writeFile(join(dir, 'notes.txt'), 'acheter du pain')
    const harness = createHarness({
      model: copyModel(),
      tools: nodeTools({ roots: [dir] }),
      authorize: askForWrites,
    })
    const seen: string[] = []
    for await (const event of harness.run('Copie notes.txt dans todo.txt', {
      conversationId: 'r1',
    })) {
      seen.push(event.type)
      if (event.type === 'question') await harness.answer('r1', event.question.callId, true)
    }
    expect(seen).toContain('question')
    expect(seen.at(-1)).toBe('done')
    expect(await readFile(join(dir, 'todo.txt'), 'utf8')).toBe('acheter du pain')
  })
})
