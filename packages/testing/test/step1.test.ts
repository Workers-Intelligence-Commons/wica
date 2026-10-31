// Step 1 gate: a turn that rebuilds its state from the journal gives the same result as a server
// that keeps it in memory.

import { journalViolations, type Item, type ItemDraft } from '@wica/core'
import { MemoryStore, runTurn, StaleEpochError, type TurnOptions } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { lastItem, memoryFiles, scriptedModel } from '../src/index.ts'

// The model reads a.txt, then answers with its content.
const model = () =>
  scriptedModel((request) => {
    const last = lastItem(request)
    if (last?.kind === 'tool_result') {
      const content = last.output[0]?.type === 'text' ? last.output[0].text : ''
      return { parts: [{ type: 'text', text: `The file says: ${content}` }] }
    }
    return {
      parts: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_call', callId: 'k1', tool: 'read_file', input: { path: 'a.txt' } },
      ],
    }
  })

const options = (store: MemoryStore): TurnOptions => ({
  store,
  model: model(),
  tools: [memoryFiles({ 'a.txt': 'hello' })],
  conversationId: 'c1',
  now: () => '2026-10-30T00:00:00.000Z',
})

const ask: NonNullable<TurnOptions['events']>[number] = {
  t: 'user_message',
  parentId: null,
  parts: [{ type: 'text', text: 'Read a.txt' }],
}
const withoutTime = (items: Item[]) => items.map(({ at: _at, ...rest }) => rest)

/** Claim by a turn that then stops without releasing anything, like a killed process. */
async function lostTurn(store: MemoryStore) {
  const claim = await store.claim('c1', 1000)
  if (!('epoch' in claim)) throw new Error('conversation already held')
  return claim.epoch
}

describe('step 1', () => {
  it('gives the same journal with or without state kept in memory, and finishes the task', async () => {
    const stateful = new MemoryStore({ salt: () => 'salt' })
    const one = await runTurn({ ...options(stateful), events: [ask] })
    expect(one.done).toBe(true)

    const stateless = new MemoryStore({ salt: () => 'salt' })
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
      text: 'The file says: hello',
      audience: 'user',
      status: 'done',
    })
  })

  it('never restarts a tool claimed by a lost turn, and gives it the unknown state error', async () => {
    let clock = 0
    const store = new MemoryStore({ salt: () => 'salt', now: () => clock })
    let ran = 0
    const files = memoryFiles({ 'a.txt': 'hello' })
    const counting = {
      ...files,
      run: async (...args: Parameters<NonNullable<typeof files.run>>) => {
        ran += 1
        return files.run!(...args)
      },
    }
    // First turn: the model asks for the tool, then the turn stops before running it.
    await runTurn({ ...options(store), tools: [counting], events: [ask], maxIntents: 1 })
    // A lost turn had claimed the tool without writing a result.
    await store.claimToolCall('c1', 'k1', await lostTurn(store))
    // Its lease expires, and the next turn resumes the conversation.
    clock += 1001

    const result = await runTurn({ ...options(store), tools: [counting] })
    expect(result.done).toBe(true)
    expect(ran).toBe(0)
    const items = (await store.load('c1', 0)).items
    expect(items.find((i) => i.kind === 'tool_result')).toMatchObject({ isError: true })
    expect(journalViolations(items)).toEqual([])
  })

  it('refuses the write of a turn made stale by a new claim', async () => {
    let clock = 0
    const store = new MemoryStore({ salt: () => 'salt', now: () => clock })
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
