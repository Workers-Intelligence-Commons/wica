import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { RowBatch } from '../src/client/sync/workers.ts'
import type { LiveFrame } from '../src/shared/live.ts'
import type { ChunkRow, ConversationRow, ItemShapeRow, ModelCallRow } from '../src/shared/rows.ts'

/** A socket the test drives: it records the sockets opened and delivers the frames given. */
class FakeSocket {
  static opened: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  readonly url: string

  constructor(url: URL) {
    this.url = String(url)
    FakeSocket.opened.push(this)
  }

  send(frame: LiveFrame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  close() {
    this.closed = true
  }
}

const item = (id: string, seq: number, status: ItemShapeRow['status'] = 'done'): ItemShapeRow => ({
  conversation_id: 'c1',
  id,
  parent_id: null,
  seq,
  kind: 'assistant_text',
  payload: { text: id },
  status,
})

const chunk = (itemId: string, idx: number): ChunkRow => ({
  conversation_id: 'c1',
  item_id: itemId,
  idx,
  text: `${itemId}-${idx}`,
})

const call = (id: string, itemIds: string[]): ModelCallRow => ({
  conversation_id: 'c1',
  id,
  item_ids: itemIds,
  model: null,
  model_name: 'wpt',
  started_at: '2026-11-01T10:00:00.000Z',
  first_token_ms: 300,
  duration_ms: 2_000,
  input_tokens: 120,
  output_tokens: 40,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning: null,
})

const row = (id: string, head: string | null): ConversationRow => ({
  id,
  owner_id: 'u1',
  organization_id: null,
  parent_conversation_id: null,
  parent_call_id: null,
  title: id,
  model: null,
  head_item_id: head,
  id_salt: 'salt',
  created_at: '',
  updated_at: '',
})

let sync: typeof import('../src/client/sync/workers.ts')
let listed: ConversationRow[] = []

beforeEach(async () => {
  FakeSocket.opened = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', new URL('https://hub.test/c/c1'))
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(listed)))
  vi.resetModules()
  sync = await import('../src/client/sync/workers.ts')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Workers sync of a conversation', () => {
  // The collections must hold exactly what the Durable Object wrote, as it changes.
  it('turns the socket frames into the row changes of the items and the batches', () => {
    const items: RowBatch<ItemShapeRow>[] = []
    const chunks: RowBatch<ChunkRow>[] = []
    sync.followItems('c1', (b) => items.push(b))
    sync.followChunks('c1', (b) => chunks.push(b))
    const [socket] = FakeSocket.opened
    expect(FakeSocket.opened).toHaveLength(1)
    expect(socket?.url).toBe('wss://hub.test/api/live/c1')

    socket?.send({ t: 'snapshot', head: 'a', items: [item('a', 1)], chunks: [], calls: [] })
    socket?.send({ t: 'items', rows: [item('b', 2, 'streaming')] })
    socket?.send({ t: 'chunks', rows: [chunk('b', 0), chunk('b', 1)] })
    socket?.send({ t: 'items', rows: [item('b', 2, 'done')] })
    socket?.send({ t: 'chunks_cleared', itemId: 'b' })

    expect(items).toEqual([
      { snapshot: [item('a', 1)] },
      { changes: [{ type: 'insert', value: item('b', 2, 'streaming') }] },
      { changes: [{ type: 'update', value: item('b', 2, 'done') }] },
    ])
    expect(chunks).toEqual([
      { snapshot: [] },
      {
        changes: [
          { type: 'insert', value: chunk('b', 0) },
          { type: 'insert', value: chunk('b', 1) },
        ],
      },
      {
        changes: [
          { type: 'delete', key: 'b:0' },
          { type: 'delete', key: 'b:1' },
        ],
      },
    ])
  })

  // The measures of each response reach the browser on the same socket as its items.
  it('turns the socket frames into the rows of the model calls', () => {
    const calls: RowBatch<ModelCallRow>[] = []
    sync.followItems('c1', () => {})
    sync.followCalls('c1', (b) => calls.push(b))
    expect(FakeSocket.opened).toHaveLength(1)
    const socket = FakeSocket.opened[0]
    socket?.send({ t: 'snapshot', head: 'a', items: [], chunks: [], calls: [call('k1', ['a'])] })
    socket?.send({ t: 'calls', rows: [call('k2', ['b', 'c'])] })
    expect(calls).toEqual([
      { snapshot: [call('k1', ['a'])] },
      { changes: [{ type: 'insert', value: call('k2', ['b', 'c']) }] },
    ])
  })

  // A view opened after the snapshot must not wait for a frame that already passed.
  it('gives a collection that arrives late the rows already delivered', () => {
    sync.followItems('c1', () => {})
    FakeSocket.opened[0]?.send({
      t: 'snapshot',
      head: null,
      items: [item('a', 1)],
      chunks: [],
      calls: [],
    })
    FakeSocket.opened[0]?.send({ t: 'items', rows: [item('b', 2)] })
    const late: RowBatch<ItemShapeRow>[] = []
    sync.followItems('c1', (b) => late.push(b))
    expect(FakeSocket.opened).toHaveLength(1)
    expect(late).toEqual([{ snapshot: [item('a', 1), item('b', 2)] }])
  })

  // A sent message is confirmed only by the row the server wrote, not by the tab's own copy.
  it('confirms an item once the socket delivers it', async () => {
    const confirm = sync.rowConfirmation('c1')
    const seen = confirm('m1', 1_000)
    FakeSocket.opened[0]?.send({ t: 'snapshot', head: null, items: [], chunks: [], calls: [] })
    FakeSocket.opened[0]?.send({ t: 'items', rows: [item('m1', 1)] })
    await expect(seen).resolves.toBe(true)
    expect(FakeSocket.opened[0]?.closed).toBe(true)
  })
})

describe('Workers sync of the conversation list', () => {
  // The list is written once per turn: reading it again must not take the screen back to an
  // older branch than the one the open conversation's socket reported.
  it('keeps the head of an open conversation ahead of the list', async () => {
    const list: RowBatch<ConversationRow>[] = []
    listed = [row('c1', 'a'), row('c2', 'x')]
    const stop = sync.followList(
      (b) => list.push(b),
      () => {},
    )
    sync.followItems('c1', () => {})
    await vi.waitFor(() => expect(list).toHaveLength(1))
    FakeSocket.opened[0]?.send({ t: 'snapshot', head: 'b', items: [], chunks: [], calls: [] })
    expect(list.at(-1)).toEqual({ changes: [{ type: 'update', value: row('c1', 'b') }] })

    sync.refreshList()
    await vi.waitFor(() => expect(list).toHaveLength(3))
    expect(list.at(-1)).toEqual({ snapshot: [row('c1', 'b'), row('c2', 'x')] })
    stop()
  })
})
