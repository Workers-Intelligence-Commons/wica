// Interfaces fournies par l'hôte pour l'exécution sans état (specs/harness.md, Exécution sans
// état et sessions), avec leurs versions en mémoire : `Scheduler` réveille une conversation,
// `SessionStore` garde ce qu'il serait coûteux de renégocier, `CredentialStore` garde les jetons
// et les rafraîchit sous exclusion mutuelle.

import type { Origin } from '@wica/core'

export interface Scheduler {
  /**
   * Demande un tour pour la conversation, après `afterMs` au plus tôt. Livraison au moins une
   * fois : un réveil en double ne fait qu'un tour sans travail.
   */
  wake(conversationId: string, options?: { afterMs?: number }): Promise<void>
}

/** Planificateur du processus : chaque réveil appelle le gestionnaire lié, après son délai. */
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
    /** Annule les réveils en attente. */
    close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  } satisfies Scheduler & Record<string, unknown>
}

/**
 * Session d'un client : l'identité résolue par l'hôte (opaque pour le Harness) et son échéance.
 * Une session est un cache : la perdre coûte une nouvelle authentification, jamais une donnée.
 */
export type Session = { id: string; identity: unknown; from: Origin; expiresAt: number }

export interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>
  put(session: Session): Promise<void>
  delete(sessionId: string): Promise<void>
  /**
   * Dernier `clientSeq` traité pour cette conversation, qui fait ignorer une commande rejouée.
   * `key` commence par l'identifiant de la session du serveur, suivi de celui du client : la
   * suppression d'une session efface aussi ses commandes.
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
  /** Jeton courant ; un jeton échu est rafraîchi d'abord. */
  get(key: string): Promise<Credential | undefined>
  /**
   * Rafraîchit le jeton sous exclusion mutuelle. `stale` est le jeton refusé : si un autre tour
   * l'a déjà remplacé, le nouveau est rendu sans second rafraîchissement.
   */
  refresh(key: string, stale?: string): Promise<Credential | undefined>
  revoke(key: string): Promise<void>
}

/** Rafraîchissement fourni par l'hôte (OAuth par exemple) : rend le jeton suivant. */
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
