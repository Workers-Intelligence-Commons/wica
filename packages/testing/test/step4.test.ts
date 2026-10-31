// Step 4 gate: transport disconnection and resume from a `seq` without duplicates, replay of a
// command by identifier, over a real WebSocket.

import { type Client, createClient, deriveView } from '@wica/client'
import type { AssistantMessage, ModelRequest } from '@wica/core'
import type { ServerTransport } from '@wica/protocol'
import { createHarness, type ModelAdapter, type ModelChunk } from '@wica/runtime'
import { connectWebSocket } from '@wica/transport-ws'
import { listenWebSocket } from '@wica/transport-ws/node'
import { describe, expect, it } from 'vite-plus/test'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Model that writes its response word by word, with a pause between two words. */
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

const finalText = (client: Client) =>
  client
    .view('c1')
    .entries.flatMap((e) => (e.type === 'assistant' && !e.streaming ? [e.text] : []))
    .at(-1)

describe('step 4', () => {
  it('resumes after a disconnection in the middle of the stream, without duplicates, with the view of the full journal', async () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i} `)
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
    await client.send('c1', 'Write thirty words')

    await until(client, () => finalText(client) === words.join(''))
    const { items, head } = await harness.store.load('c1', 0)
    // Oracle: the client view equals the one computed from the full server journal.
    expect(client.view('c1').entries).toEqual(deriveView(items, head).entries)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    expect(reopened).toBeGreaterThan(0)
    await client.close()
    await listening.close()
  })

  it('replays a command whose acknowledgement is lost, and the server runs it only once', async () => {
    const model = slowModel(['Hello.'])
    const harness = createHarness({ model, policy: { freeText: 'direct' } })
    let dropped = false
    const listening = await listenWebSocket({ port: 0, host: '127.0.0.1' }, (t) => {
      // The first command reaches the server, then the connection drops before the acknowledgement.
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
    await client.send('c1', 'Hi')
    await until(client, () => finalText(client) === 'Hello.')

    expect(dropped).toBe(true)
    const { items } = await harness.store.load('c1', 0)
    expect(items.filter((i) => i.kind === 'user_message')).toHaveLength(1)
    expect(model.calls).toBe(1)
    await client.close()
    await listening.close()
  })
})
