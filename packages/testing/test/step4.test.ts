// Porte de l'étape 4 : coupure du transport et reprise
// depuis un `seq` sans doublon, rejeu d'une commande par identifiant, sur un vrai WebSocket.

import { type Client, createClient, deriveView } from '@wica/client'
import type { AssistantMessage, ModelRequest } from '@wica/core'
import type { ServerTransport } from '@wica/protocol'
import { createHarness, type ModelAdapter, type ModelChunk } from '@wica/runtime'
import { connectWebSocket } from '@wica/transport-ws'
import { listenWebSocket } from '@wica/transport-ws/node'
import { describe, expect, it } from 'vite-plus/test'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Modèle qui écrit sa réponse mot par mot, avec une pause entre deux mots. */
function slowModel(
  words: string[],
  onDelta?: (n: number) => void,
): ModelAdapter & { calls: number } {
  const model = {
    calls: 0,
    async *stream(_request: ModelRequest): AsyncIterable<ModelChunk> {
      model.calls += 1
      for (const [n, word] of words.entries()) {
        await pause(5)
        onDelta?.(n)
        yield { type: 'text', text: word }
      }
      const message: AssistantMessage = { parts: [{ type: 'text', text: words.join('') }] }
      yield { type: 'done', message }
    },
  }
  return model
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

const finalText = (client: Client) =>
  client
    .view('c1')
    .entries.flatMap((e) => (e.type === 'assistant' && !e.streaming ? [e.text] : []))
    .at(-1)

describe('étape 4', () => {
  it('reprend après une coupure en plein flux, sans doublon, avec la vue du journal complet', async () => {
    const words = Array.from({ length: 30 }, (_, i) => `mot${i} `)
    let drop = () => {}
    const harness = createHarness({
      model: slowModel(words, (n) => n === 10 && drop()),
      policy: { freeText: 'direct' },
    })
    const listening = await listenWebSocket(
      { port: 0, host: '127.0.0.1' },
      (t) => void harness.serve(t),
    )
    drop = () => listening.dropConnections()
    const transport = connectWebSocket(`ws://127.0.0.1:${listening.port}`, { baseDelayMs: 10 })
    let reopened = 0
    transport.onReopen?.(() => (reopened += 1))
    const client = createClient(transport, { from: { channel: 'local' } })
    await client.connect()
    await client.subscribe('c1')
    await client.send('c1', 'Écris trente mots')

    await until(client, () => finalText(client) === words.join(''))
    const { items, head } = await harness.store.load('c1', 0)
    // Oracle : la vue du client égale celle calculée depuis le journal complet du serveur.
    expect(client.view('c1').entries).toEqual(deriveView(items, head).entries)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    expect(reopened).toBeGreaterThan(0)
    await client.close()
    await listening.close()
  })

  it('rejoue une commande dont l’accusé est perdu, et le serveur ne l’exécute qu’une fois', async () => {
    const model = slowModel(['Bonjour.'])
    const harness = createHarness({ model, policy: { freeText: 'direct' } })
    let dropped = false
    const listening = await listenWebSocket({ port: 0, host: '127.0.0.1' }, (t) => {
      // La première commande arrive au serveur, puis la connexion tombe avant l'accusé.
      const cut: ServerTransport = {
        ...t,
        async *receive() {
          for await (const frame of t.receive()) {
            yield frame
            if (frame.kind === 'command' && !dropped) {
              dropped = true
              listening.dropConnections()
            }
          }
        },
      }
      void harness.serve(cut)
    })
    const client = createClient(
      connectWebSocket(`ws://127.0.0.1:${listening.port}`, { baseDelayMs: 10 }),
      { from: { channel: 'local' } },
    )
    await client.connect()
    await client.subscribe('c1')
    await client.send('c1', 'Salut')
    await until(client, () => finalText(client) === 'Bonjour.')

    expect(dropped).toBe(true)
    const { items } = await harness.store.load('c1', 0)
    expect(items.filter((i) => i.kind === 'user_message')).toHaveLength(1)
    expect(model.calls).toBe(1)
    await client.close()
    await listening.close()
  })
})
