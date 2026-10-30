import type { ClientFrame, Envelope } from '@wica/protocol'
import { describe, expect, it } from 'vite-plus/test'

import { inboxTransport, MemoryCommandInbox } from '../src/index.ts'

const envelope = (n: number): Envelope => ({
  kind: 'command',
  sessionId: 's',
  commandId: `cmd-${n}`,
  clientSeq: n,
  conversationId: 'c1',
  command: { t: 'interrupt' },
})

describe('inboxTransport', () => {
  // Après une coupure, la boîte est relue depuis le dernier curseur : rien n'est livré deux fois.
  it('reprend au curseur après une coupure et rend les accusés à la boîte', async () => {
    const inbox = new MemoryCommandInbox()
    const transport = inboxTransport(inbox, { token: 'jeton', baseDelayMs: 5, heartbeatMs: 1000 })
    const frames = transport.receive()[Symbol.asyncIterator]()
    const next = async () => (await frames.next()).value as ClientFrame

    expect(await next()).toEqual({ kind: 'hello', version: 1, token: 'jeton' })
    inbox.deposit(envelope(1))
    expect(await next()).toEqual(envelope(1))

    inbox.cut({ offline: true })
    inbox.deposit(envelope(2))
    await new Promise((r) => setTimeout(r, 30))
    inbox.reconnect()
    expect(await next()).toEqual(envelope(2))

    await transport.send({ kind: 'ack', commandId: 'cmd-1', ok: true })
    await transport.send({ kind: 'ack', commandId: 'cmd-2', ok: false, error: 'refusé' })
    await new Promise((r) => setTimeout(r, 10))
    expect([...inbox.acks]).toEqual([
      ['cmd-1', { ok: true }],
      ['cmd-2', { ok: false, error: 'refusé' }],
    ])
    expect(inbox.lastSeen).toBeGreaterThan(0)
    await transport.close()
  })
})
