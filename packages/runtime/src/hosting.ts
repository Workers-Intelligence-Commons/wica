// Interfaces provided by the host for stateless execution, with their in-memory versions:
// `Scheduler` wakes a conversation, `SessionStore` keeps what would be costly to negotiate again,
// `CredentialStore` keeps the tokens and refreshes them under mutual exclusion.

import type { Origin } from '@wica/core'

export interface Scheduler {
  /**
   * Requests a turn for the conversation, after `afterMs` at the earliest. At-least-once delivery:
   * a duplicate wake-up only makes a turn with no work.
   */
  wake(conversationId: string, options?: { afterMs?: number }): Promise<void>
}

/** Process scheduler: each wake-up calls the bound handler, after its delay. */
export function memoryScheduler() {
  let handler: ((conversationId: string) => Promise<void>) | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  return {
    bind(h: (conversationId: string) => Promise<void>) {
      handler = h
    },
    async wake(conversationId: string, options: { afterMs?: number } = {}) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        void handler?.(conversationId).catch(() => {})
      }, options.afterMs ?? 0)
      timers.add(timer)
    },
    /** Cancels the pending wake-ups. */
    close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  } satisfies Scheduler & Record<string, unknown>
}

/**
 * Session of a client: the identity resolved by the host (opaque to the Harness) and its expiry.
 * A session is a cache: losing it costs a new authentication, never any data.
 */
export type Session = { id: string; identity: unknown; from: Origin; expiresAt: number }

export interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>
  put(session: Session): Promise<void>
  delete(sessionId: string): Promise<void>
  /**
   * Last `clientSeq` processed for this conversation, which makes a replayed command ignored.
   * `key` starts with the identifier of the server session, followed by the client's: deleting a
   * session also clears its commands.
   */
  lastCommand(key: string, conversationId: string): Promise<number | undefined>
  recordCommand(key: string, conversationId: string, clientSeq: number): Promise<void>
}

export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>()
  readonly #commands = new Map<string, number>()

  async get(sessionId: string) {
    return structuredClone(this.#sessions.get(sessionId))
  }

  async put(session: Session) {
    this.#sessions.set(session.id, structuredClone(session))
  }

  async delete(sessionId: string) {
    this.#sessions.delete(sessionId)
    for (const key of this.#commands.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.#commands.delete(key)
    }
  }

  async lastCommand(key: string, conversationId: string) {
    return this.#commands.get(`${key}:${conversationId}`)
  }

  async recordCommand(key: string, conversationId: string, clientSeq: number) {
    const entry = `${key}:${conversationId}`
    this.#commands.set(entry, Math.max(clientSeq, this.#commands.get(entry) ?? 0))
  }
}

export type Credential = { token: string; expiresAt?: number }

export interface CredentialStore {
  /** Current token; an expired token is refreshed first. */
  get(key: string): Promise<Credential | undefined>
  /**
   * Refreshes the token under mutual exclusion. `stale` is the refused token: if another turn has
   * already replaced it, the new one is returned without a second refresh.
   */
  refresh(key: string, stale?: string): Promise<Credential | undefined>
  revoke(key: string): Promise<void>
}

/** Refresh provided by the host (OAuth for example): returns the next token. */
export type Refresher = (key: string, current: Credential | undefined) => Promise<Credential>

export class MemoryCredentialStore implements CredentialStore {
  readonly #credentials = new Map<string, Credential>()
  readonly #locks = new Map<string, Promise<Credential | undefined>>()
  readonly #refresher: Refresher | undefined
  readonly #now: () => number

  constructor(options: { refresh?: Refresher; now?: () => number } = {}) {
    this.#refresher = options.refresh
    this.#now = options.now ?? Date.now
  }

  set(key: string, credential: Credential) {
    this.#credentials.set(key, { ...credential })
  }

  async get(key: string) {
    const current = this.#credentials.get(key)
    if (current?.expiresAt !== undefined && current.expiresAt <= this.#now()) {
      return this.refresh(key, current.token)
    }
    return current && { ...current }
  }

  refresh(key: string, stale?: string): Promise<Credential | undefined> {
    const running = this.#locks.get(key)
    if (running) return running
    const current = this.#credentials.get(key)
    if (stale !== undefined && current && current.token !== stale) {
      return Promise.resolve({ ...current })
    }
    if (!this.#refresher) return Promise.resolve(undefined)
    const refresher = this.#refresher
    const job = (async () => {
      try {
        const next = await refresher(key, current && { ...current })
        this.#credentials.set(key, { ...next })
        return { ...next }
      } finally {
        this.#locks.delete(key)
      }
    })()
    this.#locks.set(key, job)
    return job
  }

  async revoke(key: string) {
    this.#credentials.delete(key)
  }
}
