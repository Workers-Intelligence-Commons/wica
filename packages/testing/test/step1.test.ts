// Porte de l'étape 1 (specs/harness.md, Livraison par étapes) : un tour qui reconstruit son
// état depuis le journal donne le même résultat qu'un serveur qui le garde en mémoire.

import { journalViolations, type Item, type ItemDraft } from '@wica/core'
import { MemoryStore, runTurn, StaleEpochError, type TurnOptions } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { lastItem, memoryFiles, scriptedModel } from '../src/index.ts'

// Le modèle lit a.txt, puis répond avec son contenu.
const model = () =>
  scriptedModel((request) => {
    const last = lastItem(request)
    if (last?.kind === 'tool_result') {
      const content = last.output[0]?.type === 'text' ? last.output[0].text : ''
      return { parts: [{ type: 'text', text: `Le fichier dit : ${content}` }] }
    }
    return {
      parts: [
        { type: 'text', text: 'Je lis le fichier.' },
        { type: 'tool_call', callId: 'k1', tool: 'read_file', input: { path: 'a.txt' } },
      ],
    }
  })

const options = (store: MemoryStore): TurnOptions => ({
  store,
  model: model(),
  tools: [memoryFiles({ 'a.txt': 'bonjour' })],
  conversationId: 'c1',
  now: () => '2026-10-30T00:00:00.000Z',
})

const ask: NonNullable<TurnOptions['events']>[number] = {
  t: 'user_message',
  parentId: null,
  parts: [{ type: 'text', text: 'Lis a.txt' }],
}
const withoutTime = (items: Item[]) => items.map(({ at: _at, ...rest }) => rest)

/** Réclamation par un tour qui s'arrête ensuite sans rien libérer, comme un processus tué. */
async function lostTurn(store: MemoryStore) {
  const claim = await store.claim('c1', 1000)
  if (!('epoch' in claim)) throw new Error('conversation déjà tenue')
  return claim.epoch
}

describe('étape 1', () => {
  it('donne le même journal avec ou sans état gardé en mémoire, et termine la tâche', async () => {
    const stateful = new MemoryStore({ salt: () => 'sel' })
    const one = await runTurn({ ...options(stateful), events: [ask] })
    expect(one.done).toBe(true)

    const stateless = new MemoryStore({ salt: () => 'sel' })
    let result = await runTurn({ ...options(stateless), events: [ask], maxIntents: 1 })
    let turns = 1
    while (!result.done) {
      result = await runTurn({ ...options(stateless), maxIntents: 1 })
      turns += 1
    }
    expect(turns).toBeGreaterThan(2)

    const a = (await stateful.load('c1', 0)).items
    const b = (await stateless.load('c1', 0)).items
    expect(withoutTime(b)).toEqual(withoutTime(a))
    expect(journalViolations(a)).toEqual([])
    expect(a.at(-1)).toMatchObject({
      kind: 'assistant_text',
      text: 'Le fichier dit : bonjour',
      audience: 'user',
      status: 'done',
    })
  })

  it("ne relance jamais un outil réclamé par un tour perdu, et lui donne l'erreur d'état inconnu", async () => {
    let clock = 0
    const store = new MemoryStore({ salt: () => 'sel', now: () => clock })
    let ran = 0
    const files = memoryFiles({ 'a.txt': 'bonjour' })
    const counting = {
      ...files,
      run: async (...args: Parameters<NonNullable<typeof files.run>>) => {
        ran += 1
        return files.run!(...args)
      },
    }
    // Premier tour : le modèle demande l'outil, puis le tour s'arrête avant de l'exécuter.
    await runTurn({ ...options(store), tools: [counting], events: [ask], maxIntents: 1 })
    // Un tour perdu avait réclamé l'outil sans écrire de résultat.
    await store.claimToolCall('c1', 'k1', await lostTurn(store))
    // Son bail échoit, et le tour suivant reprend la conversation.
    clock += 1001

    const result = await runTurn({ ...options(store), tools: [counting] })
    expect(result.done).toBe(true)
    expect(ran).toBe(0)
    const items = (await store.load('c1', 0)).items
    expect(items.find((i) => i.kind === 'tool_result')).toMatchObject({ isError: true })
    expect(journalViolations(items)).toEqual([])
  })

  it("refuse l'écriture d'un tour périmé par une nouvelle réclamation", async () => {
    let clock = 0
    const store = new MemoryStore({ salt: () => 'sel', now: () => clock })
    const old = await lostTurn(store)
    clock += 1001
    await lostTurn(store)
    const draft: ItemDraft = {
      id: 'x',
      parentId: null,
      at: 't',
      status: 'done',
      kind: 'user_message',
      parts: [],
    }
    await expect(store.append('c1', [draft], old)).rejects.toBeInstanceOf(StaleEpochError)
    expect((await store.load('c1', 0)).items).toEqual([])
  })
})
