// Suites de conformité : ce que tout
// `Store`, tout transport et tout adaptateur de modèle doit tenir. Chaque suite reçoit une
// fabrique qui donne une instance neuve : les implémentations du dépôt les lancent dans les tests
// de ce paquet, une application les lance dans les siens pour ses propres implémentations.

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
  if (!('epoch' in claim)) throw new Error('conversation tenue')
  return claim.epoch
}

/** Une écriture avec un `epoch` périmé échoue en `StaleEpochError`. */
const stale = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ name: 'StaleEpochError' })

export function storeConformance(name: string, make: () => Store | Promise<Store>) {
  describe(`conformité du Store : ${name}`, () => {
    it('attribue des seq croissants, relit depuis un seq et accuse un doublon sans le dupliquer', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      const first = await store.append('c', [message('a', 'un'), message('b', 'deux', 'a')], epoch)
      const [a, b] = first.persisted
      expect(a && b && a.seq < b.seq).toBe(true)
      const again = await store.append('c', [message('b', 'deux', 'a')], epoch)
      expect(again.persisted).toEqual([b])
      const all = await store.load('c', 0)
      expect(all.items.map((i) => i.id)).toEqual(['a', 'b'])
      expect(all.head).toBe('b')
      expect((await store.load('c', a?.seq ?? 0)).items.map((i) => i.id)).toEqual(['b'])
      expect((await store.load('c', 0)).salt).toBe(all.salt)
    })

    it('refuse une seconde réclamation pendant un bail, et rend l’écriture d’un epoch périmé impossible', async () => {
      const store = await make()
      const first = await claimed(store, 'c')
      const busy = await store.claim('c', 60_000)
      expect('busyForMs' in busy && busy.busyForMs > 0).toBe(true)
      await store.release('c', first)
      const second = await claimed(store, 'c')
      expect(second).toBeGreaterThan(first)
      await stale(store.append('c', [message('a', 'un')], first))
      await stale(store.renew('c', first))
      await stale(store.setHead('c', 'a', first))
      expect((await store.load('c', 0)).items).toEqual([])
    })

    it('réclame un outil une fois par epoch : rejouée par le même tour, refusée par un autre', async () => {
      const store = await make()
      const first = await claimed(store, 'c')
      expect(await store.claimToolCall('c', 'k1', first)).toBe('claimed')
      expect(await store.claimToolCall('c', 'k1', first)).toBe('claimed')
      await store.release('c', first)
      const second = await claimed(store, 'c')
      expect(await store.claimToolCall('c', 'k1', second)).toBe('already_claimed')
      expect(await store.claimToolCall('c', 'k2', second)).toBe('claimed')
    })

    it('règle un élément en flux sans changer son seq, et déplace la tête', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      await store.append('c', [message('u', 'Bonjour')], epoch)
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
      await store.appendBatch('c', 't', 0, 'Sal', epoch)
      await store.appendBatch('c', 't', 1, 'ut', epoch)
      await store.settle('c', { ...streaming, status: 'done', text: 'Salut' }, epoch)
      const [settled] = (await store.load('c', seq - 1)).items
      expect(settled).toMatchObject({ id: 't', seq, status: 'done', text: 'Salut' })
      await store.setHead('c', 'u', epoch)
      expect((await store.load('c', 0)).head).toBe('u')
    })

    it('signale une interruption demandée aux écritures, jusqu’à son effacement', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      await store.requestInterrupt('c')
      expect((await store.load('c', 0)).interruptRequested).toBe(true)
      expect((await store.append('c', [message('a', 'un')], epoch)).interruptRequested).toBe(true)
      await store.clearInterrupt('c', epoch)
      expect((await store.load('c', 0)).interruptRequested).toBe(false)
    })

    it('garde le dernier instantané écrit', async () => {
      const store = await make()
      const epoch = await claimed(store, 'c')
      expect(await store.loadSnapshot('c')).toBeUndefined()
      const [{ seq } = { seq: 0 }] = (await store.append('c', [message('a', 'un')], epoch))
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
  /** Libère ce que la fabrique a ouvert (serveur à l'écoute, processus). */
  close?: () => Promise<void>
}

/** Lit les `n` prochaines trames d'un flux. */
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
  describe(`conformité du transport : ${name}`, () => {
    it('livre les trames dans l’ordre, dans les deux sens', async () => {
      const pair = await make()
      const fromClient: ClientFrame[] = [
        { kind: 'hello', version: 1, token: 'jeton' },
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

    it('termine la lecture du serveur quand le client ferme', async () => {
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
 * Scénario que joue le faux fournisseur derrière l'adaptateur : `text` répond « Bonjour. » en
 * plusieurs morceaux, `tool_call` appelle `read_file` avec `{ path: 'a.txt' }` et le `callId`
 * `k1`, `failure` échoue de façon définitive, `endless` écrit du texte sans fin.
 */
export type ModelScenario = 'text' | 'tool_call' | 'failure' | 'endless'

const request = {
  trigger: 'u',
  path: [{ ...message('u', 'Bonjour'), seq: 1 }],
  tools: [
    {
      name: 'read_file',
      description: 'Lit un fichier texte.',
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
  describe(`conformité de l’adaptateur de modèle : ${name}`, () => {
    it('rend le texte en deltas puis un seul message final, qui le reprend', async () => {
      const chunks = await collect(make('text'))
      const done = chunks.filter((c) => c.type === 'done')
      expect(done).toHaveLength(1)
      expect(chunks.at(-1)?.type).toBe('done')
      const text = chunks.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('')
      expect(text).toBe('Bonjour.')
      expect(done[0]?.type === 'done' && done[0].message.parts).toContainEqual({
        type: 'text',
        text: 'Bonjour.',
      })
    })

    it('rend un appel d’outil avec son identifiant, son nom et son entrée', async () => {
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

    it('échoue par une erreur quand le fournisseur échoue', async () => {
      await expect(collect(make('failure'))).rejects.toBeInstanceOf(Error)
    })

    it('s’arrête sans message final quand le tour annule', async () => {
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
