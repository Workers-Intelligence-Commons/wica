// Interfaces d'hébergement du Harness sur Postgres : sessions des clients, réveils des
// conversations (table de reprise dans le Compose, Cloudflare Queues sur Workers) et jetons de
// modèle des personnes, chiffrés par la clé de l'instance.

import type {
  Credential as PiCredential,
  CredentialStore as PiCredentialStore,
} from '@earendil-works/pi-ai'
import type { Scheduler, Session, SessionStore } from '@wica/runtime'
import type postgres from 'postgres'

import { decrypt, encrypt, type InstanceKey } from './crypto.ts'

export class PgSessionStore implements SessionStore {
  readonly #sql: postgres.Sql

  constructor(sql: postgres.Sql) {
    this.#sql = sql
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const [row] = await this.#sql<{ state: Omit<Session, 'expiresAt'>; expires: number }[]>`
      UPDATE sessions SET last_seen_at = now() WHERE id = ${sessionId}
      RETURNING state, (EXTRACT(EPOCH FROM expires_at) * 1000)::float8 AS expires`
    return row && { ...row.state, expiresAt: row.expires }
  }

  async put(session: Session) {
    const { expiresAt, ...state } = session
    const identity = session.identity as { userId?: string; serverId?: string } | null
    await this.#sql`
      INSERT INTO sessions (id, user_id, server_id, state, expires_at)
      VALUES (${session.id}, ${identity?.userId ?? null}, ${identity?.serverId ?? null},
              ${this.#sql.json(state as postgres.JSONValue)}, to_timestamp(${expiresAt / 1000}))
      ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at,
                                     last_seen_at = now()`
  }

  async delete(sessionId: string) {
    await this.#sql`DELETE FROM sessions WHERE id = ${sessionId}`
  }

  async lastCommand(key: string, conversationId: string) {
    const [row] = await this.#sql<{ client_seq: number }[]>`
      SELECT client_seq FROM session_commands
      WHERE key = ${key} AND conversation_id = ${conversationId}`
    return row?.client_seq
  }

  async recordCommand(key: string, conversationId: string, clientSeq: number) {
    // La clé commence par l'identifiant de la session du serveur (voir `SessionStore`).
    const sessionId = key.split(':')[0] ?? key
    await this.#sql`
      INSERT INTO session_commands (session_id, key, conversation_id, client_seq)
      VALUES (${sessionId}, ${key}, ${conversationId}, ${clientSeq})
      ON CONFLICT (key, conversation_id)
      DO UPDATE SET client_seq = GREATEST(session_commands.client_seq, EXCLUDED.client_seq)`
  }
}

/**
 * Planificateur du Compose : un réveil est une ligne de `wakeups`, que le processus de
 * l'application réclame pendant son tour, par une réclamation courte prolongée tant que le tour
 * tourne. Une ligne n'est effacée qu'après son tour : un arrêt du processus en plein tour la
 * laisse en place, et elle redevient échue dès la fin de sa réclamation.
 */
export function pgScheduler(sql: postgres.Sql) {
  const scheduler: Scheduler = {
    async wake(conversationId, options = {}) {
      // Pendant qu'un tour tient la ligne, le réveil demandé attend dans `rearm_at`.
      await sql`
        INSERT INTO wakeups (conversation_id, due_at)
        VALUES (${conversationId}, now() + ${options.afterMs ?? 0} * interval '1 millisecond')
        ON CONFLICT (conversation_id) DO UPDATE SET
          due_at = CASE WHEN wakeups.claimed_until > now() THEN wakeups.due_at
                        ELSE LEAST(wakeups.due_at, EXCLUDED.due_at) END,
          rearm_at = CASE WHEN wakeups.claimed_until > now()
                          THEN LEAST(COALESCE(wakeups.rearm_at, EXCLUDED.due_at), EXCLUDED.due_at)
                          ELSE wakeups.rearm_at END`
    },
  }

  /** Réclame jusqu'à `limit` réveils échus, pour `claimMs` au plus. */
  async function due(limit: number, claimMs: number) {
    return sql<{ conversation_id: string }[]>`
      UPDATE wakeups SET claimed_until = now() + ${claimMs} * interval '1 millisecond'
      WHERE conversation_id IN (
        SELECT conversation_id FROM wakeups
        WHERE due_at <= now() AND (claimed_until IS NULL OR claimed_until <= now())
        ORDER BY due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING conversation_id`
  }

  async function extend(conversationId: string, claimMs: number) {
    await sql`
      UPDATE wakeups SET claimed_until = now() + ${claimMs} * interval '1 millisecond'
      WHERE conversation_id = ${conversationId}`
  }

  /** Fin d'un tour : la ligne disparaît, ou devient le réveil demandé pendant le tour. */
  async function done(conversationId: string) {
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM wakeups WHERE conversation_id = ${conversationId} AND rearm_at IS NULL`
      await tx`
        UPDATE wakeups SET due_at = rearm_at, rearm_at = NULL, claimed_until = NULL
        WHERE conversation_id = ${conversationId}`
    })
  }

  /**
   * Boucle du processus : chaque réveil échu appelle `handler`, plusieurs conversations à la fois.
   * Rend une fonction d'arrêt.
   */
  function run(
    handler: (conversationId: string) => Promise<void>,
    options: { intervalMs?: number; concurrency?: number; claimMs?: number } = {},
  ) {
    const interval = options.intervalMs ?? 250
    const concurrency = options.concurrency ?? 8
    const claimMs = options.claimMs ?? 60_000
    let running = 0
    let stopped = false
    const tick = async () => {
      if (stopped || running >= concurrency) return
      const rows = await due(concurrency - running, claimMs).catch(() => [])
      for (const row of rows) {
        running += 1
        const renewal = setInterval(
          () => void extend(row.conversation_id, claimMs).catch(() => {}),
          claimMs / 3,
        )
        void handler(row.conversation_id)
          .catch(() => {})
          .finally(() => clearInterval(renewal))
          .then(() => done(row.conversation_id))
          .catch(() => {})
          .finally(() => (running -= 1))
      }
    }
    const timer = setInterval(() => void tick(), interval)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  return { ...scheduler, run }
}

/** File Cloudflare : le message porte la conversation, son délai est celui du réveil. */
export type WakeQueue = {
  send(body: { conversationId: string }, options?: { delaySeconds?: number }): Promise<void>
}

/** Délai maximal d'un message de Cloudflare Queues ; un réveil plus lointain est relayé. */
export const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60

export function queueScheduler(queue: WakeQueue): Scheduler {
  return {
    async wake(conversationId, options = {}) {
      const seconds = Math.ceil((options.afterMs ?? 0) / 1000)
      await queue.send(
        { conversationId },
        seconds > 0 ? { delaySeconds: Math.min(seconds, MAX_QUEUE_DELAY_SECONDS) } : {},
      )
    },
  }
}

/**
 * Jetons de modèle d'une personne pour pi-ai, une ligne par fournisseur. `modify` verrouille la
 * ligne (`SELECT ... FOR UPDATE`), si bien que deux tours ne rafraîchissent pas le même jeton.
 * Le premier usage d'un abonnement est noté par `warned_at`.
 */
export class PgModelCredentials implements PiCredentialStore {
  readonly #sql: postgres.Sql
  readonly #userId: string
  readonly #key: InstanceKey

  constructor(sql: postgres.Sql, userId: string, key: InstanceKey) {
    this.#sql = sql
    this.#userId = userId
    this.#key = key
  }

  async #read(sql: postgres.Sql | postgres.TransactionSql, provider: string, lock: boolean) {
    const rows = lock
      ? await sql<{ id: string; ciphertext: string; key_id: string }[]>`
          SELECT id, ciphertext, key_id FROM model_credentials
          WHERE user_id = ${this.#userId} AND provider = ${provider} AND revoked_at IS NULL
          FOR UPDATE`
      : await sql<{ id: string; ciphertext: string; key_id: string }[]>`
          SELECT id, ciphertext, key_id FROM model_credentials
          WHERE user_id = ${this.#userId} AND provider = ${provider} AND revoked_at IS NULL`
    const row = rows[0]
    if (!row) return undefined
    return { id: row.id, credential: JSON.parse(await decrypt(this.#key, row)) as PiCredential }
  }

  async read(provider: string) {
    return (await this.#read(this.#sql, provider, false))?.credential
  }

  async list() {
    const rows = await this.#sql<{ provider: string; kind: PiCredential['type'] }[]>`
      SELECT provider, kind FROM model_credentials
      WHERE user_id = ${this.#userId} AND revoked_at IS NULL`
    return rows.map((r) => ({ providerId: r.provider, type: r.kind }))
  }

  async modify(
    provider: string,
    fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
  ) {
    return this.#sql.begin(async (sql) => {
      const current = await this.#read(sql, provider, true)
      const next = await fn(current?.credential)
      if (next === undefined) return current?.credential
      const sealed = await encrypt(this.#key, JSON.stringify(next))
      if (current) {
        await sql`
          UPDATE model_credentials
          SET ciphertext = ${sealed.ciphertext}, key_id = ${sealed.key_id}, kind = ${next.type}
          WHERE id = ${current.id}`
      } else {
        await sql`
          INSERT INTO model_credentials (id, user_id, provider, kind, ciphertext, key_id)
          VALUES (${crypto.randomUUID()}, ${this.#userId}, ${provider}, ${next.type},
                  ${sealed.ciphertext}, ${sealed.key_id})`
      }
      return next
    })
  }

  async delete(provider: string) {
    await this.#sql`
      UPDATE model_credentials SET revoked_at = now()
      WHERE user_id = ${this.#userId} AND provider = ${provider} AND revoked_at IS NULL`
  }

  /** Vrai la première fois seulement : l'avertissement d'abonnement n'est donné qu'une fois. */
  async markWarned(provider: string): Promise<boolean> {
    const updated = await this.#sql`
      UPDATE model_credentials SET warned_at = now()
      WHERE user_id = ${this.#userId} AND provider = ${provider}
        AND revoked_at IS NULL AND warned_at IS NULL`
    return updated.count > 0
  }
}
