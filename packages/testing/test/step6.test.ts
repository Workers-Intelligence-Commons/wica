// Step 6 gate: stateless turns with the in-memory versions of `Store`, `Scheduler`,
// `SessionStore` and `CredentialStore`. Two server processes share the same `Store`, like two
// serverless invocations.

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

/** Model that answers only once `release` is called. */
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
    if (Date.now() > deadline) throw new Error('timed out')
    await pause(10)
  }
}

/** A raw client: `hello`, then frames as they are, to replay the same command. */
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
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
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

describe('step 6', () => {
  it('two simultaneous turns: only the one that holds the conversation writes', async () => {
    let clock = 0
    const store = new MemoryStore({ now: () => clock })
    const held = heldModel('Response from A')
    // A long lease, never extended during the test: A behaves like a frozen process.
    const a = createHarness({
      model: held.model,
      store,
      leaseMs: 60_000,
      policy: { freeText: 'direct' },
    })
    const b = createHarness({
      model: reply('Response from B'),
      store,
      leaseMs: 60_000,
      policy: { freeText: 'direct' },
    })
    const { client: end, server } = memoryTransportPair()
    void a.serve(server)
    const client = createClient(end, { from: { channel: 'local' } })
    await client.connect()
    await client.send('c1', 'Hello')
    await held.started

    // As long as A holds its lease, B reads and writes nothing.
    await b.wake('c1')
    expect(assistantTexts((await store.load('c1', 0)).items)).toEqual([])

    // A's lease expires: B claims the conversation and finishes the turn.
    clock += 61_000
    await b.wake('c1')
    held.release()
    while (!held.model.finished) await pause(5)
    await pause(20)

    const { items } = await store.load('c1', 0)
    expect(assistantTexts(items)).toEqual(['Response from B'])
    expect(journalViolations(items)).toEqual([])
    await client.close()
  })

  it('a command and a wake-up delivered twice to two processes create no duplicate', async () => {
    const store = new MemoryStore()
    const model = reply('Hello.')
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
        parts: [{ type: 'text' as const, text: 'Hi' }],
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
    expect(assistantTexts(final)).toEqual(['Hello.'])
    expect(model.requests).toHaveLength(1)
    expect(final).toHaveLength(items.length)
    expect(journalViolations(final)).toEqual([])
  })

  it('a resumed session avoids an authentication; lost, it costs only one', async () => {
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
      model: reply('Hello.'),
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

    // The server forgets the session: the client reopens one without the person seeing it.
    for (const id of sessions.ids) await sessions.delete(id)
    listening.dropConnections()
    while (reopened < 2) await pause(5)
    await client.send('c1', 'Hi')
    await until(client, () =>
      client.view('c1').entries.some((e) => e.type === 'assistant' && e.text === 'Hello.'),
    )
    expect(authentications).toBe(2)
    expect(client.view('c1').error).toBeUndefined()
    await client.close()
    await listening.close()
  })

  it('a turn that restarts from a snapshot writes the same journal as a turn that reads everything again', async () => {
    const run = async (snapshotEvery: number) => {
      const store = new MemoryStore({ salt: () => 'salt' })
      const harness = createHarness({
        model: scriptedModel((r) => ({
          parts: [
            {
              type: 'text',
              text: `Response ${r.path.filter((i) => i.kind === 'user_message').length}`,
            },
          ],
        })),
        store,
        snapshotEvery,
        policy: { freeText: 'direct' },
        now: () => '2026-10-30T00:00:00.000Z',
      })
      for (const text of ['one', 'two', 'three']) {
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

  it('a snapshot stops before the first item still streaming', () => {
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

  it('two turns that refresh the same token refresh it only once', async () => {
    let refreshes = 0
    const credentials = new MemoryCredentialStore({
      refresh: async () => {
        refreshes += 1
        await pause(10)
        return { token: `token-${refreshes + 1}` }
      },
    })
    credentials.set('mcp:notes', { token: 'token-1' })
    const [first, second] = await Promise.all([
      credentials.refresh('mcp:notes', 'token-1'),
      credentials.refresh('mcp:notes', 'token-1'),
    ])
    // A third turn that had read the old token receives the new one without refreshing.
    const late = await credentials.refresh('mcp:notes', 'token-1')
    expect([first?.token, second?.token, late?.token]).toEqual(['token-2', 'token-2', 'token-2'])
    expect(refreshes).toBe(1)
  })
})
