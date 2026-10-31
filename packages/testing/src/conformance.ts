// Conformance suites: what every `Store`, every transport and every model adapter must hold. Each
// suite receives a factory that gives a fresh instance: the repository implementations run them
// in the tests of this package, an application runs them in its own tests for its own
// implementations.

import type { ItemDraft } from '@wica/core'
import type { ClientFrame, ClientTransport, ServerFrame, ServerTransport } from '@wica/protocol'
import type { ModelAdapter, ModelChunk, Snapshot, Store } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

const message = (id: string, text: string, parentId: string | null = null): ItemDraft => ({
  id,
  parentId,
  at: '2026-10-30T10:00:00.000Z',
  status: 'done',
  kind: 'user_message',
  parts: [{ type: 'text', text }],
})

const claimed = async (store: Store, conversationId: string, leaseMs = 60_000) => {
  const claim = await store.claim(conversationId, leaseMs)
  if (!('epoch' in claim)) throw new Error('conversation held')
  return claim.epoch
}

/** A write with a stale `epoch` fails with `StaleEpochError`. */
const stale = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: 'StaleEpochError' })

export function storeConformance(name: string, make: () => Store | Promise<Store>) {
  describe(`Store conformance: ${name}`, () => {
    it('assigns increasing seq values, reads again from a seq and acknowledges a duplicate without duplicating it', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      const first = await store.append('c', [message('a', 'one'), message('b', 'two', 'a')], epoch)
      const [a, b] = first.persisted
      expect(a && b && a.seq < b.seq).toBe(true)
      const again = await store.append('c', [message('b', 'two', 'a')], epoch)
      expect(again.persisted).toEqual([b])
      const all = await store.load('c', 0)
      expect(all.items.map((i) => i.id)).toEqual(['a', 'b'])
      expect(all.head).toBe('b')
      expect((await store.load('c', a?.seq ?? 0)).items.map((i) => i.id)).toEqual(['b'])
      expect((await store.load('c', 0)).salt).toBe(all.salt)
    })

    it('refuses a second claim during a lease, and makes the write of a stale epoch impossible', async () => {
      const store = await make()
      const first = await claimed(store, 'c')
      const busy = await store.claim('c', 60_000)
      expect('busyForMs' in busy && busy.busyForMs > 0).toBe(true)
      await store.release('c', first)
      const second = await claimed(store, 'c')
      expect(second).toBeGreaterThan(first)
      await stale(store.append('c', [message('a', 'one')], first))
      await stale(store.renew('c', first))
      await stale(store.setHead('c', 'a', first))
      expect((await store.load('c', 0)).items).toEqual([])
    })

    it('claims a tool once per epoch: replayed by the same turn, refused by another', async () => {
      const store = await make()
      const first = await claimed(store, 'c')
      expect(await store.claimToolCall('c', 'k1', first)).toBe('claimed')
      expect(await store.claimToolCall('c', 'k1', first)).toBe('claimed')
      await store.release('c', first)
      const second = await claimed(store, 'c')
      expect(await store.claimToolCall('c', 'k1', second)).toBe('already_claimed')
      expect(await store.claimToolCall('c', 'k2', second)).toBe('claimed')
    })

    it('settles a streaming item without changing its seq, and moves the head', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      await store.append('c', [message('u', 'Hello')], epoch)
      const streaming: ItemDraft = {
        id: 't',
        parentId: 'u',
        at: '2026-10-30T10:00:00.000Z',
        status: 'streaming',
        kind: 'assistant_text',
        text: '',
        audience: 'user',
      }
      const [{ seq } = { seq: 0 }] = (await store.append('c', [streaming], epoch)).persisted
      await store.appendBatch('c', 't', 0, 'H', epoch)
      await store.appendBatch('c', 't', 1, 'i', epoch)
      await store.settle('c', { ...streaming, status: 'done', text: 'Hi' }, epoch)
      const [settled] = (await store.load('c', seq - 1)).items
      expect(settled).toMatchObject({ id: 't', seq, status: 'done', text: 'Hi' })
      await store.setHead('c', 'u', epoch)
      expect((await store.load('c', 0)).head).toBe('u')
    })

    it('reports a requested interruption to the writes, until it is cleared', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      await store.requestInterrupt('c')
      expect((await store.load('c', 0)).interruptRequested).toBe(true)
      expect((await store.append('c', [message('a', 'one')], epoch)).interruptRequested).toBe(true)
      await store.clearInterrupt('c', epoch)
      expect((await store.load('c', 0)).interruptRequested).toBe(false)
    })

    // The turn that resumes a conversation after a stop settles the open item with this text.
    it('reads a streaming item again with its batches joined in order, then its final text', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      const open: ItemDraft = {
        id: 'r',
        parentId: null,
        at: '2026-10-30T10:00:00.000Z',
        status: 'streaming',
        kind: 'assistant_text',
        text: '',
        audience: 'private',
      }
      await store.append('c', [open], epoch)
      await store.appendBatch('c', 'r', 1, 'lo', epoch)
      await store.appendBatch('c', 'r', 0, 'Hel', epoch)
      expect((await store.load('c', 0)).items[0]).toMatchObject({
        status: 'streaming',
        text: 'Hello',
      })
      await store.settle('c', { ...open, status: 'done', text: 'Hello!' }, epoch)
      expect((await store.load('c', 0)).items[0]).toMatchObject({
        status: 'done',
        text: 'Hello!',
      })
    })

    it('keeps the last snapshot written', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      expect(await store.loadSnapshot('c')).toBeUndefined()
      const [{ seq } = { seq: 0 }] = (await store.append('c', [message('a', 'one')], epoch))
        .persisted
      const { items } = await store.load('c', 0)
      const snapshot: Snapshot = { schema: 1, seq, items }
      await store.saveSnapshot('c', snapshot, epoch)
      expect(await store.loadSnapshot('c')).toEqual(snapshot)
    })
  })
}

export type TransportPair = {
  client: ClientTransport
  server: ServerTransport
  /** Releases what the factory opened (listening server, process). */
  close?: () => Promise<void>
}

/** Reads the next `n` frames of a stream. */
async function take<F>(frames: AsyncIterator<F>, n: number): Promise<F[]> {
  const out: F[] = []
  while (out.length < n) {
    const next = await frames.next()
    if (next.done) break
    out.push(next.value)
  }
  return out
}

export function transportConformance(name: string, make: () => Promise<TransportPair>) {
  describe(`transport conformance: ${name}`, () => {
    it('delivers the frames in order, in both directions', async () => {
      const pair = await make()
      const fromClient: ClientFrame[] = [
        { kind: 'hello', version: 1, token: 'token' },
        { kind: 'subscribe', conversationId: 'c', fromSeq: 0 },
        { kind: 'ping' },
      ]
      const fromServer: ServerFrame[] = [
        { kind: 'welcome', version: 1, sessionId: 's', resumed: false },
        { kind: 'status', conversationId: 'c', running: false },
        { kind: 'ack', commandId: 'k', ok: true },
      ]
      const serverFrames = pair.server.receive()[Symbol.asyncIterator]()
      const clientFrames = pair.client.receive()[Symbol.asyncIterator]()
      for (const frame of fromClient) await pair.client.send(frame)
      expect(await take(serverFrames, fromClient.length)).toEqual(fromClient)
      for (const frame of fromServer) await pair.server.send(frame)
      expect(await take(clientFrames, fromServer.length)).toEqual(fromServer)
      await pair.client.close()
      await pair.server.close()
      await pair.close?.()
    })

    it('ends the server read when the client closes', async () => {
      const pair = await make()
      const serverFrames = pair.server.receive()[Symbol.asyncIterator]()
      await pair.client.send({ kind: 'ping' })
      expect(await take(serverFrames, 1)).toEqual([{ kind: 'ping' }])
      await pair.client.close()
      expect((await serverFrames.next()).done).toBe(true)
      await pair.server.close()
      await pair.close?.()
    })
  })
}

/**
 * Scenario played by the fake provider behind the adapter: `text` answers "Hello." in several
 * chunks, `tool_call` calls `read_file` with `{ path: 'a.txt' }` and the `callId` `k1`, `failure`
 * fails permanently, `endless` writes text without end.
 */
export type ModelScenario = 'text' | 'tool_call' | 'failure' | 'endless'

const request = {
  trigger: 'u',
  path: [{ ...message('u', 'Hello'), seq: 1 }],
  tools: [
    {
      name: 'read_file',
      description: 'Reads a text file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      channel: 'environment' as const,
    },
  ],
}

async function collect(adapter: ModelAdapter, signal = new AbortController().signal) {
  const chunks: ModelChunk[] = []
  for await (const chunk of adapter.stream(request, signal)) chunks.push(chunk)
  return chunks
}

export function modelAdapterConformance(
  name: string,
  make: (scenario: ModelScenario) => ModelAdapter,
) {
  describe(`model adapter conformance: ${name}`, () => {
    it('returns the text in deltas then a single final message, which repeats it', async () => {
      const chunks = await collect(make('text'))
      const done = chunks.filter((c) => c.type === 'done')
      expect(done).toHaveLength(1)
      expect(chunks.at(-1)?.type).toBe('done')
      const text = chunks.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
      expect(text).toBe('Hello.')
      expect(done[0]?.type === 'done' && done[0].message.parts).toContainEqual({
        type: 'text',
        text: 'Hello.',
      })
    })

    it('returns a tool call with its identifier, its name and its input', async () => {
      const chunks = await collect(make('tool_call'))
      const done = chunks.at(-1)
      expect(done?.type).toBe('done')
      expect(done?.type === 'done' && done.message.parts).toContainEqual(
        expect.objectContaining({
          type: 'tool_call',
          callId: 'k1',
          tool: 'read_file',
          input: { path: 'a.txt' },
        }),
      )
    })

    it('fails with an error when the provider fails', async () => {
      await expect(collect(make('failure'))).rejects.toBeInstanceOf(Error)
    })

    it('stops without a final message when the turn cancels', async () => {
      const abort = new AbortController()
      const seen: ModelChunk[] = []
      const run = (async () => {
        for await (const chunk of make('endless').stream(request, abort.signal)) {
          seen.push(chunk)
          if (seen.length === 2) abort.abort()
        }
      })()
      await run.catch(() => {})
      expect(seen.length).toBeGreaterThanOrEqual(2)
      expect(seen.some((c) => c.type === 'done')).toBe(false)
    })
  })
}
