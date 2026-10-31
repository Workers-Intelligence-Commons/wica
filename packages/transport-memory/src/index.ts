// In-memory transport: client and server in the same process.

import type { ClientTransport, Frame, ServerTransport, Transport } from '@wica/protocol'

class Queue<T> {
  readonly #items: T[] = []
  readonly #waiting: ((r: IteratorResult<T>) => void)[] = []
  #closed = false

  push(item: T) {
    if (this.#closed) return
    const waiter = this.#waiting.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.#items.push(item)
  }

  close() {
    this.#closed = true
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  async *iterate(): AsyncIterable<T> {
    for (;;) {
      const item = this.#items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.#closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => this.#waiting.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}

function end<Out extends Frame, In extends Frame>(
  inbox: Queue<In>,
  outbox: Queue<Out>,
): Transport<Out, In> {
  return {
    // Structured copy: the two sides never share an object, as on a real network.
    send: async (frame) => outbox.push(structuredClone(frame)),
    receive: () => inbox.iterate(),
    close: async () => {
      inbox.close()
      outbox.close()
    },
  }
}

/** Two linked ends: what one sends, the other receives. */
export function memoryTransportPair(): { client: ClientTransport; server: ServerTransport } {
  const toServer = new Queue<Parameters<ClientTransport['send']>[0]>()
  const toClient = new Queue<Parameters<ServerTransport['send']>[0]>()
  return { client: end(toClient, toServer), server: end(toServer, toClient) }
}
