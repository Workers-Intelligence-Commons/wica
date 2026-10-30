// Porte de l'étape 6 : tours sans état avec les
// versions en mémoire de `Store`, `Scheduler`, `SessionStore` et `CredentialStore`. Deux
// processus du serveur partagent un même `Store`, comme deux invocations serverless.

import { type Client, createClient } from '@wica/client'
import { type Item, journalViolations } from '@wica/core'
import type { ClientFrame, ServerFrame } from '@wica/protocol'
import {
  type ClientAuth,
  createHarness,
  MemoryCredentialStore,
  MemorySessionStore,
  MemoryStore,
  type ModelAdapter,
  type ModelChunk,
  type Session,
  takeSnapshot,
} from '@wica/runtime'
import { memoryTransportPair } from '@wica/transport-memory'
import { connectWebSocket } from '@wica/transport-ws'
import { listenWebSocket } from '@wica/transport-ws/node'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Modèle qui ne répond qu'une fois `release` appelé. */
function heldModel(text: string) {
  let release: () => void = () => {}
  const released = new Promise<void>((r) => (release = r))
  let started: () => void = () => {}
  const startedP = new Promise<void>((r) => (started = r))
  const model: ModelAdapter & { finished: boolean } = {
    finished: false,
    async *stream(): AsyncIterable<ModelChunk> {
      started()
      try {
        await released
        yield { type: 'text', text }
        yield { type: 'done', message: { parts: [{ type: 'text', text }] } }
      } finally {
        model.finished = true
      }
    },
  }
  return { model, release, started: startedP }
}

const reply = (text: string) => scriptedModel(() => ({ parts: [{ type: 'text', text }] }))

const assistantTexts = (items: Item[]) =>
  items.flatMap((i) => (i.kind === 'assistant_text' ? [i.text] : []))

async function settled(store: MemoryStore, ready: (items: Item[]) => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    const { items } = await store.load('c1', 0)
    if (ready(items)) return items
    if (Date.now() > deadline) throw new Error('délai dépassé')
    await pause(10)
  }
}

/** Un client brut : `hello`, puis des trames telles quelles, pour rejouer une même commande. */
async function rawClient(harness: ReturnType<typeof createHarness>) {
  const { client, server } = memoryTransportPair()
  void harness.serve(server)
  const frames: ServerFrame[] = []
  void (async () => {
    for await (const frame of client.receive()) frames.push(frame)
  })()
  await client.send({ kind: 'hello', version: 1 })
  const wait = async (match: (f: ServerFrame) => boolean) => {
    while (!frames.some(match)) await pause(5)
    return frames.find(match)!
  }
  const welcome = (await wait((f) => f.kind === 'welcome')) as Extract<
    ServerFrame,
    { kind: 'welcome' }
  >
  return {
    sessionId: welcome.sessionId,
    send: (frame: ClientFrame) => client.send(frame),
    wait,
  }
}

function until(client: Client, ready: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('délai dépassé')), ms)
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

describe('étape 6', () => {
  it('deux tours simultanés : seul celui qui tient la conversation écrit', async () => {
    let clock = 0
    const store = new MemoryStore({ now: () => clock })
    const held = heldModel('Réponse de A')
    // Un bail long, jamais prolongé pendant le test : A se comporte comme un processus figé.
    const a = createHarness({
      model: held.model,
      store,
      leaseMs: 60_000,
      policy: { freeText: 'direct' },
    })
    const b = createHarness({
      model: reply('Réponse de B'),
      store,
      leaseMs: 60_000,
      policy: { freeText: 'direct' },
    })
    const { client: end, server } = memoryTransportPair()
    void a.serve(server)
    const client = createClient(end, { from: { channel: 'local' } })
    await client.connect()
    await client.send('c1', 'Bonjour')
    await held.started

    // Tant que A tient son bail, B ne lit ni n'écrit rien.
    await b.wake('c1')
    expect(assistantTexts((await store.load('c1', 0)).items)).toEqual([])

    // Le bail de A échoit : B réclame la conversation et termine le tour.
    clock += 61_000
    await b.wake('c1')
    held.release()
    while (!held.model.finished) await pause(5)
    await pause(20)

    const { items } = await store.load('c1', 0)
    expect(assistantTexts(items)).toEqual(['Réponse de B'])
    expect(journalViolations(items)).toEqual([])
    await client.close()
  })

  it('une commande et un réveil livrés deux fois à deux processus ne créent aucun doublon', async () => {
    const store = new MemoryStore()
    const model = reply('Bonjour.')
    const a = createHarness({ model, store, policy: { freeText: 'direct' } })
    const b = createHarness({ model, store, policy: { freeText: 'direct' } })
    const one = await rawClient(a)
    const two = await rawClient(b)
    const command = {
      kind: 'command' as const,
      commandId: 'cmd-1',
      clientSeq: 1,
      conversationId: 'c1',
      command: {
        t: 'send' as const,
        parentId: null,
        parts: [{ type: 'text' as const, text: 'Salut' }],
      },
    }
    await Promise.all([
      one.send({ ...command, sessionId: one.sessionId }),
      two.send({ ...command, sessionId: two.sessionId }),
      a.wake('c1'),
      a.wake('c1'),
      b.wake('c1'),
    ])
    await one.wait((f) => f.kind === 'ack' && f.ok)
    await two.wait((f) => f.kind === 'ack' && f.ok)
    const items = await settled(store, (i) => assistantTexts(i).length > 0)
    await pause(50)

    const final = (await store.load('c1', 0)).items
    expect(final.filter((i) => i.kind === 'user_message')).toHaveLength(1)
    expect(assistantTexts(final)).toEqual(['Bonjour.'])
    expect(model.requests).toHaveLength(1)
    expect(final).toHaveLength(items.length)
    expect(journalViolations(final)).toEqual([])
  })

  it('une session reprise évite une authentification ; perdue, elle en coûte une seule', async () => {
    let authentications = 0
    const auth: ClientAuth = {
      authenticate: async () => {
        authentications += 1
        return { identity: 'owner', from: { channel: 'local', trust: 'owner' } }
      },
      canAccess: async () => true,
    }
    class Sessions extends MemorySessionStore {
      readonly ids = new Set<string>()
      override async put(session: Session) {
        this.ids.add(session.id)
        return super.put(session)
      }
    }
    const sessions = new Sessions()
    const harness = createHarness({
      model: reply('Bonjour.'),
      auth,
      sessions,
      policy: { freeText: 'direct' },
    })
    const listening = await listenWebSocket(
      { port: 0, host: '127.0.0.1' },
      (t) => void harness.serve(t),
    )
    const transport = connectWebSocket(`ws://127.0.0.1:${listening.port}`, { baseDelayMs: 10 })
    let reopened = 0
    transport.onReopen?.(() => (reopened += 1))
    const client = createClient(transport, { from: { channel: 'local' } })
    await client.connect()
    await client.subscribe('c1')
    expect(authentications).toBe(1)

    listening.dropConnections()
    while (reopened < 1) await pause(5)
    await pause(30)
    expect(authentications).toBe(1)

    // Le serveur oublie la session : le client en rouvre une sans que la personne le voie.
    for (const id of sessions.ids) await sessions.delete(id)
    listening.dropConnections()
    while (reopened < 2) await pause(5)
    await client.send('c1', 'Salut')
    await until(client, () =>
      client.view('c1').entries.some((e) => e.type === 'assistant' && e.text === 'Bonjour.'),
    )
    expect(authentications).toBe(2)
    expect(client.view('c1').error).toBeUndefined()
    await client.close()
    await listening.close()
  })

  it('un tour qui repart d’un instantané écrit le même journal qu’un tour qui relit tout', async () => {
    const run = async (snapshotEvery: number) => {
      const store = new MemoryStore({ salt: () => 'sel' })
      const harness = createHarness({
        model: scriptedModel((r) => ({
          parts: [
            {
              type: 'text',
              text: `Réponse ${r.path.filter((i) => i.kind === 'user_message').length}`,
            },
          ],
        })),
        store,
        snapshotEvery,
        policy: { freeText: 'direct' },
        now: () => '2026-10-30T00:00:00.000Z',
      })
      for (const text of ['un', 'deux', 'trois']) {
        for await (const event of harness.run(text, { conversationId: 'c1' })) void event
      }
      return store
    }
    const withSnapshots = await run(1)
    const without = await run(1000)
    expect(await withSnapshots.loadSnapshot('c1')).toBeDefined()
    expect(await without.loadSnapshot('c1')).toBeUndefined()
    expect((await withSnapshots.load('c1', 0)).items).toEqual((await without.load('c1', 0)).items)
  })

  it('un instantané s’arrête avant le premier élément encore en flux', () => {
    const item = (seq: number, status: Item['status']): Item => ({
      id: `i${seq}`,
      parentId: null,
      seq,
      at: 't',
      status,
      kind: 'user_message',
      parts: [],
    })
    const snapshot = takeSnapshot([item(3, 'done'), item(1, 'done'), item(2, 'streaming')])
    expect(snapshot).toMatchObject({ seq: 1, items: [{ id: 'i1' }] })
  })

  it('deux tours qui rafraîchissent le même jeton ne le rafraîchissent qu’une fois', async () => {
    let refreshes = 0
    const credentials = new MemoryCredentialStore({
      refresh: async () => {
        refreshes += 1
        await pause(10)
        return { token: `jeton-${refreshes + 1}` }
      },
    })
    credentials.set('mcp:notes', { token: 'jeton-1' })
    const [first, second] = await Promise.all([
      credentials.refresh('mcp:notes', 'jeton-1'),
      credentials.refresh('mcp:notes', 'jeton-1'),
    ])
    // Un troisième tour qui avait lu l'ancien jeton reçoit le nouveau sans rafraîchir.
    const late = await credentials.refresh('mcp:notes', 'jeton-1')
    expect([first?.token, second?.token, late?.token]).toEqual(['jeton-2', 'jeton-2', 'jeton-2'])
    expect(refreshes).toBe(1)
  })
})
