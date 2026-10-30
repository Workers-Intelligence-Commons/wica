// Transport WebSocket JSON (specs/harness.md, Transports et accès). Ce fichier n'utilise que
// l'API WebSocket standard : il sert côté serveur sur toute plateforme qui fournit un socket
// (Workers compris) et côté client. Le serveur Node est dans `./node`.

import type {
  ClientFrame,
  ClientTransport,
  Frame,
  ServerFrame,
  ServerTransport,
  Transport,
} from '@wica/protocol'

/** Le sous-ensemble de l'API WebSocket standard dont le transport a besoin. */
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
 * Transport sur un socket déjà accepté, côté serveur. Une trame envoyée après la fermeture est
 * perdue sans erreur : le client reprend à son curseur et rejoue ses commandes.
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

/** Côté serveur : le socket d'une connexion entrante devient un `ServerTransport`. */
export const serveWebSocket = (socket: SocketLike): ServerTransport =>
  socketTransport<ServerFrame, ClientFrame>(socket)

export type ConnectOptions = {
  /** Constructeur WebSocket ; celui de la plateforme par défaut. */
  WebSocket?: new (url: string) => SocketLike
  /** Première attente avant une reconnexion ; elle double à chaque échec. 200 ms par défaut. */
  baseDelayMs?: number
  /** Attente maximale entre deux tentatives. 10 s par défaut. */
  maxDelayMs?: number
  /** Intervalle du battement de cœur ; sans trame reçue pendant deux intervalles, on reconnecte. */
  heartbeatMs?: number
}

/**
 * Côté client : un transport qui se reconnecte seul, avec une attente croissante, et signale
 * chaque reconnexion par `onReopen` pour que le client reprenne à son curseur.
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
      socket.addEventListener('error', () => reject(new Error(`connexion impossible : ${url}`)))
      socket.addEventListener('close', () => reject(new Error(`connexion impossible : ${url}`)))
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
        if (Date.now() - lastSeen > 2 * heartbeat) socket.close(4000, 'battement de cœur perdu')
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
      // Une trame attend une connexion ouverte ; perdue si la connexion tombe pendant l'envoi,
      // elle est rejouée par le client à la reconnexion.
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
