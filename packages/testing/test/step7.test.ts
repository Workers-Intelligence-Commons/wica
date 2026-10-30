// Porte de l'étape 7 (specs/harness.md, Livraison par étapes) : un serveur distant suit la boîte
// de commandes de l'hôte par une connexion sortante et écrit par le `Store` de l'hôte. Une
// coupure en plein outil laisse l'outil se terminer ; le résultat est écrit au retour du réseau,
// et le client reprend depuis son dernier `seq` sans doublon.

import { type Client, createClient, deriveView } from '@wica/client'
import { journalViolations } from '@wica/core'
import { createHarness, MemoryStore, resilientStore, type Store, type Tool } from '@wica/runtime'
import { inboxTransport, MemoryCommandInbox } from '@wica/transport-inbox'
import { connectWebSocket } from '@wica/transport-ws'
import { listenWebSocket } from '@wica/transport-ws/node'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Le `Store` de l'hôte vu à travers un réseau qu'on peut couper. */
function network(store: Store) {
  const link = { offline: false }
  const remote = new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        if (link.offline) throw new TypeError('réseau coupé')
        return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args)
      }
    },
  })
  return { remote, link }
}

function until(ready: () => boolean | Promise<boolean>, ms = 3000) {
  return (async () => {
    const deadline = Date.now() + ms
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error('délai dépassé')
      await pause(5)
    }
  })()
}

describe('étape 7', () => {
  it('termine l’outil pendant une coupure, écrit au retour, et le client rattrape sans doublon', async () => {
    const host = new MemoryStore()
    const { remote, link } = network(host)
    const inbox = new MemoryCommandInbox()

    let release: () => void = () => {}
    const released = new Promise<void>((r) => (release = r))
    let started = false
    let runs = 0
    let aborted = false
    const longTask: Tool = {
      spec: {
        name: 'long_task',
        description: 'Une tâche longue.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        channel: 'environment',
      },
      run: async (_input, ctx) => {
        runs += 1
        started = true
        await released
        aborted = ctx.signal.aborted
        return [{ type: 'text', text: 'terminé' }]
      },
    }
    const model = scriptedModel((request) =>
      request.path.some((i) => i.kind === 'tool_result')
        ? { parts: [{ type: 'text', text: 'Fini.' }] }
        : { parts: [{ type: 'tool_call', callId: 'k1', tool: 'long_task', input: {} }] },
    )
    // Le serveur distant : un bail court, qui échoit pendant la coupure sans que rien ne casse.
    const server = createHarness({
      model,
      tools: [longTask],
      store: resilientStore(remote, { baseDelayMs: 5, maxDelayMs: 20 }),
      leaseMs: 300,
      policy: { freeText: 'direct' },
    })
    const transport = inboxTransport(inbox, { baseDelayMs: 5 })
    void server.serve(transport)

    // L'hôte sert la lecture aux clients depuis son propre `Store`.
    const reader = createHarness({ model: scriptedModel(() => ({ parts: [] })), store: host })
    const listening = await listenWebSocket(
      { port: 0, host: '127.0.0.1' },
      (t) => void reader.serve(t),
    )
    const ws = connectWebSocket(`ws://127.0.0.1:${listening.port}`, { baseDelayMs: 10 })
    let reopened = 0
    ws.onReopen?.(() => (reopened += 1))
    const client: Client = createClient(ws, { from: { channel: 'local' } })
    await client.connect()
    await client.subscribe('c1')

    inbox.deposit({
      kind: 'command',
      sessionId: 'web',
      commandId: 'cmd-1',
      clientSeq: 1,
      conversationId: 'c1',
      command: { t: 'send', parentId: null, parts: [{ type: 'text', text: 'Lance la tâche' }] },
    })
    await until(() => started)

    // Coupure complète en plein outil : la boîte, le `Store` distant et le client.
    inbox.cut({ offline: true })
    link.offline = true
    listening.dropConnections()
    release()
    await pause(400)
    expect(runs).toBe(1)

    link.offline = false
    inbox.reconnect()
    await until(async () =>
      (await host.load('c1', 0)).items.some(
        (i) => i.kind === 'assistant_text' && i.text === 'Fini.' && i.status === 'done',
      ),
    )
    // La synchro de l'hôte livre la suite : le client reprend depuis son dernier `seq`.
    const before = reopened
    listening.dropConnections()
    await until(() => reopened > before)
    const { items, head } = await host.load('c1', 0)
    await until(() => client.view('c1').entries.length === deriveView(items, head).entries.length)

    expect(aborted).toBe(false)
    expect(runs).toBe(1)
    expect(items.filter((i) => i.kind === 'tool_result')).toMatchObject([
      { callId: 'k1', output: [{ type: 'text', text: 'terminé' }] },
    ])
    expect(client.view('c1').entries).toEqual(deriveView(items, head).entries)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    expect(journalViolations(items)).toEqual([])
    await until(() => inbox.acks.get('cmd-1')?.ok === true)
    await transport.close()
    await client.close()
    await listening.close()
  })
})
