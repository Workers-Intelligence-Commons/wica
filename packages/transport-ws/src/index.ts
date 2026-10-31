// JSON WebSocket transport. This file uses only the standard WebSocket API: it serves on the
// server side on any platform that provides a socket (Workers included) and on the client side.
// The Node server is in `./node`.

import type {
  ClientFrame,
  ClientTransport,
  Frame,
  ServerFrame,
  ServerTransport,
  Transport,
} from '@wica/protocol'

/** The subset of the standard WebSocket API that the transport needs. */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

const OPEN = 1

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

const parse = (data: unknown): unknown => {
  try {
    return JSON.parse(typeof data === 'string' ? data : String(data))
  } catch {
    return undefined
  }
}

/**
 * Transport over an already accepted socket, on the server side. A frame sent after closing is
 * lost without an error: the client resumes at its cursor and replays its commands.
 */
export function socketTransport<Out extends Frame, In extends Frame>(
  socket: SocketLike,
): Transport<Out, In> {
  const inbox = new Queue<In>()
  socket.addEventListener('message', (event) => {
    const frame = parse(event.data)
    if (frame && typeof frame === 'object') inbox.push(frame as In)
  })
  socket.addEventListener('close', () => inbox.close())
  socket.addEventListener('error', () => inbox.close())
  return {
    send: async (frame) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(frame))
    },
    receive: () => inbox.iterate(),
    close: async () => {
      socket.close(1000)
      inbox.close()
    },
  }
}

/** Server side: the socket of an incoming connection becomes a `ServerTransport`. */
export const serveWebSocket = (socket: SocketLike): ServerTransport =>
  socketTransport<ServerFrame, ClientFrame>(socket)

export type ConnectOptions = {
  /** WebSocket constructor; the platform's by default. */
  WebSocket?: new (url: string) => SocketLike
  /** First wait before a reconnection; it doubles at each failure. 200 ms by default. */
  baseDelayMs?: number
  /** Maximum wait between two attempts. 10 s by default. */
  maxDelayMs?: number
  /** Heartbeat interval; without a frame received during two intervals, reconnect. */
  heartbeatMs?: number
}

/**
 * Client side: a transport that reconnects on its own, with a growing wait, and reports each
 * reconnection through `onReopen` so that the client resumes at its cursor.
 */
export function connectWebSocket(url: string, options: ConnectOptions = {}): ClientTransport {
  const Socket =
    options.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => SocketLike)
  const base = options.baseDelayMs ?? 200
  const max = options.maxDelayMs ?? 10_000
  const heartbeat = options.heartbeatMs ?? 15_000
  const inbox = new Queue<ServerFrame>()
  const reopenListeners = new Set<() => void>()
  const stop = new AbortController()
  let current: SocketLike | null = null
  let ready: () => void = () => {}
  let opened = new Promise<void>((resolve) => (ready = resolve))

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      stop.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

  const open = () =>
    new Promise<SocketLike>((resolve, reject) => {
      const socket = new Socket(url)
      socket.addEventListener('open', () => resolve(socket))
      socket.addEventListener('error', () => reject(new Error(`connection failed: ${url}`)))
      socket.addEventListener('close', () => reject(new Error(`connection failed: ${url}`)))
    })

  const follow = (socket: SocketLike) =>
    new Promise<void>((resolve) => {
      let lastSeen = Date.now()
      socket.addEventListener('message', (event) => {
        lastSeen = Date.now()
        const frame = parse(event.data) as ServerFrame | undefined
        if (frame && frame.kind !== 'pong') inbox.push(frame)
      })
      const timer = setInterval(() => {
        if (Date.now() - lastSeen > 2 * heartbeat) socket.close(4000, 'heartbeat lost')
        else if (socket.readyState === OPEN) socket.send(JSON.stringify({ kind: 'ping' }))
      }, heartbeat)
      socket.addEventListener('close', () => (clearInterval(timer), resolve()))
      stop.signal.addEventListener('abort', () => (clearInterval(timer), socket.close(1000)))
    })

  void (async () => {
    let failures = 0
    let first = true
    while (!stop.signal.aborted) {
      const socket = await open().catch(() => null)
      if (!socket) {
        await sleep(Math.min(base * 2 ** failures++, max))
        continue
      }
      failures = 0
      current = socket
      ready()
      if (!first) reopenListeners.forEach((l) => l())
      first = false
      await follow(socket)
      current = null
      opened = new Promise<void>((resolve) => (ready = resolve))
      await sleep(base)
    }
  })()

  return {
    async send(frame) {
      // A frame waits for an open connection; lost if the connection drops during the send, it
      // is replayed by the client at reconnection.
      while (!current || current.readyState !== OPEN) {
        if (stop.signal.aborted) return
        await opened
      }
      current.send(JSON.stringify(frame))
    },
    receive: () => inbox.iterate(),
    async close() {
      stop.abort()
      current?.close(1000)
      inbox.close()
      ready()
    },
    onReopen(listener) {
      reopenListeners.add(listener)
      return () => reopenListeners.delete(listener)
    },
  }
}
