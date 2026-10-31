// Transport with intermediate storage: the host places the commands in a `CommandInbox`, which the
// server follows through an outgoing connection; it therefore crosses a router with nothing
// incoming. The server writes its items through the host's `Store`, and the clients read them
// through the host's sync: this transport carries only the commands and their acknowledgements.

import {
  type Envelope,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type ServerTransport,
} from '@wica/protocol'

/** A placed command, with its position in the inbox. */
export type InboxEntry = { cursor: string; envelope: Envelope }

export type InboxAck = { ok: true } | { ok: false; error: string }

/** Command inbox of a server, provided by the host. */
export interface CommandInbox {
  /**
   * Commands after `cursor`, then live, as long as the connection holds; without a cursor, all
   * those that have no acknowledgement. The stream ends or fails when the connection drops.
   */
  follow(cursor: string | null, signal: AbortSignal): AsyncIterable<InboxEntry>
  ack(commandId: string, result: InboxAck): Promise<void>
  /** Server heartbeat, which lets the client show "server offline". */
  heartbeat(): Promise<void>
}

export type InboxOptions = {
  /** Server token, presented in `hello`. */
  token?: string
  /** First wait before a reconnection; it doubles at each failure. 200 ms by default. */
  baseDelayMs?: number
  /** Maximum wait between two attempts. 30 s by default. */
  maxDelayMs?: number
  /** Heartbeat interval. 15 s by default. */
  heartbeatMs?: number
  /** Refusal of the connection by the server (authentication), which otherwise would process nothing. */
  onRefused?: (message: string) => void
}

/**
 * The inbox seen as a server transport: `harness.serve(inboxTransport(inbox))`. After a
 * disconnection, the inbox is read again from the last cursor received; a command replayed
 * anyway is deduplicated by the server.
 */
export function inboxTransport(inbox: CommandInbox, options: InboxOptions = {}): ServerTransport {
  const base = options.baseDelayMs ?? 200
  const max = options.maxDelayMs ?? 30_000
  const stop = new AbortController()
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      stop.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), {
        once: true,
      })
    })

  /** A lost acknowledgement would leave the command pending at the host: it is retried. */
  const ack = async (commandId: string, result: InboxAck) => {
    for (let failures = 0; !stop.signal.aborted; failures++) {
      try {
        return await inbox.ack(commandId, result)
      } catch {
        await sleep(Math.min(base * 2 ** failures, max))
      }
    }
  }

  async function* receive(): AsyncIterable<ClientFrame> {
    yield {
      kind: 'hello',
      version: PROTOCOL_VERSION,
      ...(options.token ? { token: options.token } : {}),
    }
    heartbeat = setInterval(
      () => void inbox.heartbeat().catch(() => {}),
      options.heartbeatMs ?? 15_000,
    )
    void inbox.heartbeat().catch(() => {})
    let cursor: string | null = null
    let failures = 0
    while (!stop.signal.aborted) {
      try {
        for await (const entry of inbox.follow(cursor, stop.signal)) {
          failures = 0
          cursor = entry.cursor
          yield entry.envelope
        }
      } catch {
        // Connection lost: resume at the cursor after a growing wait.
      }
      if (!stop.signal.aborted) await sleep(Math.min(base * 2 ** failures++, max))
    }
  }

  return {
    async send(frame: ServerFrame) {
      if (frame.kind === 'ack') {
        void ack(frame.commandId, frame.ok ? { ok: true } : { ok: false, error: frame.error })
      } else if (frame.kind === 'error' && !frame.conversationId) {
        options.onRefused?.(frame.message)
      }
    },
    receive,
    async close() {
      stop.abort()
      clearInterval(heartbeat)
    },
  }
}

/** In-memory inbox for the tests: `deposit` plays the host, `cut` cuts the connection. */
export class MemoryCommandInbox implements CommandInbox {
  readonly #entries: InboxEntry[] = []
  readonly acks = new Map<string, InboxAck>()
  /** Last heartbeat received, in milliseconds. */
  lastSeen = 0
  #online = true
  #wake: (() => void)[] = []
  #generation = 0

  deposit(envelope: Envelope) {
    this.#entries.push({ cursor: String(this.#entries.length + 1), envelope })
    this.#notify()
  }

  /** Cuts the current connections; while offline, every new connection fails. */
  cut(options: { offline?: boolean } = {}) {
    this.#online = !options.offline
    this.#generation += 1
    this.#notify()
  }

  reconnect() {
    this.#online = true
  }

  #notify() {
    for (const wake of this.#wake.splice(0)) wake()
  }

  async *follow(cursor: string | null, signal: AbortSignal): AsyncIterable<InboxEntry> {
    if (!this.#online) throw new TypeError('command inbox unreachable')
    const generation = this.#generation
    let next = cursor === null ? 0 : Number(cursor)
    for (;;) {
      if (signal.aborted) return
      if (generation !== this.#generation) throw new TypeError('connection lost')
      const entry = this.#entries[next]
      if (entry) {
        next += 1
        if (cursor === null && this.acks.has(entry.envelope.commandId)) continue
        yield entry
        continue
      }
      await new Promise<void>((resolve) => {
        this.#wake.push(resolve)
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }

  async ack(commandId: string, result: InboxAck) {
    if (!this.#online) throw new TypeError('command inbox unreachable')
    this.acks.set(commandId, result)
  }

  async heartbeat() {
    if (!this.#online) throw new TypeError('command inbox unreachable')
    this.lastSeen = Date.now()
  }
}
