import { storeConformance } from '@wica/testing'
import type { ItemDraft } from '@wica/core'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { describe, expect, it } from 'vite-plus/test'

import { migrateConversation } from '../src/server/do/migrations.ts'
import { DoStore, journalRows } from '../src/server/do/store.ts'
import type { LiveFrame } from '../src/shared/live.ts'
import type { ModelCallRow } from '../src/shared/rows.ts'
import { durableStorage } from './sqlite.ts'

/** A conversation database migrated by the files the Durable Object applies. */
async function conversationDb() {
  const db = drizzle(durableStorage() as never)
  await migrateConversation(db)
  return db
}

// The Workers journal must keep the same contract as every other Harness store.
storeConformance('Durable Object SQLite', async () => {
  const db = await conversationDb()
  return new DoStore(
    db,
    async () => 'salt',
    () => {},
  )
})

const streaming: ItemDraft = {
  id: 't',
  parentId: null,
  at: '2026-10-31T10:00:00.000Z',
  status: 'streaming',
  kind: 'assistant_text',
  text: '',
  audience: 'user',
} as ItemDraft

describe('Durable Object journal', () => {
  // On Workers the browser sees only these frames: each committed write must reach it, in the
  // order the rows changed, and a refused write must not.
  it('reports each committed write to the sockets, and nothing for a refused write', async () => {
    const db = await conversationDb()
    const frames: LiveFrame[] = []
    const store = new DoStore(
      db,
      async () => 'salt',
      (frame) => frames.push(frame),
    )
    const claim = await store.claim('c1', 60_000)
    if (!('epoch' in claim)) throw new Error('conversation held')
    await store.append('c1', [streaming], claim.epoch)
    await store.appendBatch('c1', 't', 0, 'Hel', claim.epoch)
    await store.appendBatch('c1', 't', 1, 'lo', claim.epoch)
    expect(journalRows(db, 'c1').chunks.map((c) => c.text)).toEqual(['Hel', 'lo'])
    await store.settle(
      'c1',
      { ...streaming, status: 'done', text: 'Hello' } as ItemDraft,
      claim.epoch,
    )
    await expect(store.setHead('c1', 't', claim.epoch - 1)).rejects.toMatchObject({
      name: 'StaleEpochError',
    })

    const row = (status: string, text: string) => ({
      conversation_id: 'c1',
      id: 't',
      parent_id: null,
      seq: 1,
      kind: 'assistant_text',
      status,
      payload: expect.objectContaining({ text }),
    })
    expect(frames).toEqual([
      { t: 'items', rows: [row('streaming', '')] },
      { t: 'head', head: 't' },
      { t: 'chunks', rows: [{ conversation_id: 'c1', item_id: 't', idx: 0, text: 'Hel' }] },
      { t: 'chunks', rows: [{ conversation_id: 'c1', item_id: 't', idx: 1, text: 'lo' }] },
      { t: 'items', rows: [row('done', 'Hello')] },
      { t: 'chunks_cleared', itemId: 't' },
    ])
    expect(journalRows(db, 'c1')).toMatchObject({ head: 't', chunks: [] })
  })

  // A tab that opens or reconnects gets the measures of the responses already written.
  it('sends a recorded model call to the sockets and keeps it in the snapshot', async () => {
    const db = await conversationDb()
    const frames: LiveFrame[] = []
    const store = new DoStore(
      db,
      async () => 'salt',
      (f) => frames.push(f),
    )
    await store.ensure('c1')
    const call: ModelCallRow = {
      conversation_id: 'c1',
      id: 'k1',
      item_ids: ['a', 'b'],
      model: 'pi:anthropic/claude-a',
      model_name: 'Claude A',
      started_at: '2026-11-01T10:00:00.000Z',
      first_token_ms: 420,
      duration_ms: 3_100,
      input_tokens: 900,
      output_tokens: 150,
      cache_read_tokens: 800,
      cache_write_tokens: 0,
      reasoning: null,
    }
    await store.recordCall(call)
    expect(frames).toEqual([{ t: 'calls', rows: [call] }])
    expect(journalRows(db, 'c1').calls).toEqual([call])
  })
})
