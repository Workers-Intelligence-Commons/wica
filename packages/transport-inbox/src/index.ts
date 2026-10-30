// Transport à stockage intermédiaire (specs/harness.md, Transports et accès) : l'hôte dépose
// les commandes dans une `CommandInbox`, que le serveur suit par une connexion sortante ; il
// traverse donc un routeur sans rien d'entrant. Le serveur écrit ses éléments par le `Store` de
// l'hôte, et les clients les lisent par la synchro de l'hôte : ce transport ne porte que les
// commandes et leurs accusés.

import {
  type Envelope,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type ServerTransport,
} from '@wica/protocol'

/** Une commande déposée, avec sa position dans la boîte. */
export type InboxEntry = { cursor: string; envelope: Envelope }

export type InboxAck = { ok: true } | { ok: false; error: string }

/** Boîte de commandes d'un serveur, fournie par l'hôte. */
export interface CommandInbox {
  /**
   * Commandes après `cursor`, puis en direct, tant que la connexion tient ; sans curseur, toutes
   * celles qui n'ont pas d'accusé. Le flux finit ou échoue quand la connexion tombe.
   */
  follow(cursor: string | null, signal: AbortSignal): AsyncIterable<InboxEntry>
  ack(commandId: string, result: InboxAck): Promise<void>
  /** Battement de cœur du serveur, qui permet au client d'afficher « serveur hors ligne ». */
  heartbeat(): Promise<void>
}

export type InboxOptions = {
  /** Jeton du serveur, présenté dans `hello`. */
  token?: string
  /** Première attente avant une reconnexion ; elle double à chaque échec. 200 ms par défaut. */
  baseDelayMs?: number
  /** Attente maximale entre deux tentatives. 30 s par défaut. */
  maxDelayMs?: number
  /** Intervalle du battement de cœur. 15 s par défaut. */
  heartbeatMs?: number
  /** Refus de la connexion par le serveur (authentification), qui sinon ne traiterait rien. */
  onRefused?: (message: string) => void
}

/**
 * La boîte vue comme un transport de serveur : `harness.serve(inboxTransport(boîte))`. Après
 * une coupure, la boîte est relue depuis le dernier curseur reçu ; une commande rejouée malgré
 * tout est dédoublonnée par le serveur.
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

  /** Un accusé perdu laisserait la commande en attente chez l'hôte : il est réessayé. */
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
        // Connexion perdue : on reprend au curseur après une attente croissante.
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

/** Boîte en mémoire pour les tests : `deposit` joue l'hôte, `cut` coupe la connexion. */
export class MemoryCommandInbox implements CommandInbox {
  readonly #entries: InboxEntry[] = []
  readonly acks = new Map<string, InboxAck>()
  /** Dernier battement de cœur reçu, en millisecondes. */
  lastSeen = 0
  #online = true
  #wake: (() => void)[] = []
  #generation = 0

  deposit(envelope: Envelope) {
    this.#entries.push({ cursor: String(this.#entries.length + 1), envelope })
    this.#notify()
  }

  /** Coupe les connexions en cours ; hors ligne, toute nouvelle connexion échoue. */
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
    if (!this.#online) throw new TypeError('boîte de commandes injoignable')
    const generation = this.#generation
    let next = cursor === null ? 0 : Number(cursor)
    for (;;) {
      if (signal.aborted) return
      if (generation !== this.#generation) throw new TypeError('connexion perdue')
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
    if (!this.#online) throw new TypeError('boîte de commandes injoignable')
    this.acks.set(commandId, result)
  }

  async heartbeat() {
    if (!this.#online) throw new TypeError('boîte de commandes injoignable')
    this.lastSeen = Date.now()
  }
}
