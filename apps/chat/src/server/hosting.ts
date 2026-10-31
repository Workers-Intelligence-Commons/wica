// Harness hosting interfaces on Postgres: client sessions, conversation wake-ups (resume table in
// Compose, Cloudflare Queues on Workers), and people's model tokens, encrypted by the instance
// key.

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
    // The key starts with the identifier of the server session (see `SessionStore`).
    const sessionId = key.split(':')[0] ?? key
    await this.#sql`
      INSERT INTO session_commands (session_id, key, conversation_id, client_seq)
      VALUES (${sessionId}, ${key}, ${conversationId}, ${clientSeq})
      ON CONFLICT (key, conversation_id)
      DO UPDATE SET client_seq = GREATEST(session_commands.client_seq, EXCLUDED.client_seq)`
  }
}

/**
 * Compose scheduler: a wake-up is a row of `wakeups`, which the application process claims for
 * its turn, with a short claim extended as long as the turn runs. A row is deleted only after its
 * turn: a process stop in the middle of a turn leaves it in place, and it becomes due again as
 * soon as its claim ends.
 */
export function pgScheduler(sql: postgres.Sql) {
  const scheduler: Scheduler = {
    async wake(conversationId, options = {}) {
      // While a turn holds the row, the requested wake-up waits in `rearm_at`.
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

  /** Claims up to `limit` due wake-ups, for at most `claimMs`. */
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

  /** End of a turn: the row disappears, or becomes the wake-up requested during the turn. */
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
   * Process loop: each due wake-up calls `handler`, several conversations at a time. Returns a
   * stop function.
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

/** Cloudflare queue: the message carries the conversation, its delay is the wake-up's. */
export type WakeQueue = {
  send(body: { conversationId: string }, options?: { delaySeconds?: number }): Promise<void>
}

/** Maximum delay of a Cloudflare Queues message; a later wake-up is relayed. */
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
 * A person's model tokens for pi-ai, one row per provider. `modify` locks the row
 * (`SELECT ... FOR UPDATE`), so two turns do not refresh the same token. The first use of a
 * subscription is recorded by `warned_at`.
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

  /** True the first time only: the subscription warning is given only once. */
  async markWarned(provider: string): Promise<boolean> {
    const updated = await this.#sql`
      UPDATE model_credentials SET warned_at = now()
      WHERE user_id = ${this.#userId} AND provider = ${provider}
        AND revoked_at IS NULL AND warned_at IS NULL`
    return updated.count > 0
  }
}
