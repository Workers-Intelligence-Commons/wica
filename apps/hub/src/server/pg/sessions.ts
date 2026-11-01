// Harness client sessions on Postgres, with the last `clientSeq` processed per client and per
// conversation.

import type { Session, SessionStore } from '@wica/runtime'
import { and, eq, sql } from 'drizzle-orm'

import type { Db } from './db.ts'
import { accountOf } from '../data.ts'
import { sessionCommands, sessions } from './schema.ts'

export class PgSessionStore implements SessionStore {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const [row] = await this.#db
      .update(sessions)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(sessions.id, sessionId))
      .returning({
        state: sessions.state,
        expires: sql<number>`(EXTRACT(EPOCH FROM ${sessions.expiresAt}) * 1000)::float8`,
      })
    return row && { ...(row.state as Omit<Session, 'expiresAt'>), expiresAt: row.expires }
  }

  async put(session: Session) {
    const { expiresAt, ...state } = session
    const identity = session.identity as { userId?: string } | null
    const expires = sql`to_timestamp(${expiresAt / 1000})`
    await this.#db
      .insert(sessions)
      .values({ id: session.id, userId: accountOf(identity?.userId), state, expiresAt: expires })
      .onConflictDoUpdate({
        target: sessions.id,
        set: { state, expiresAt: expires, lastSeenAt: sql`now()` },
      })
  }

  async delete(sessionId: string) {
    await this.#db.delete(sessions).where(eq(sessions.id, sessionId))
  }

  async lastCommand(key: string, conversationId: string) {
    const [row] = await this.#db
      .select({ clientSeq: sessionCommands.clientSeq })
      .from(sessionCommands)
      .where(and(eq(sessionCommands.key, key), eq(sessionCommands.conversationId, conversationId)))
    return row?.clientSeq
  }

  async recordCommand(key: string, conversationId: string, clientSeq: number) {
    // The key starts with the identifier of the server session (see `SessionStore`).
    const sessionId = key.split(':')[0] ?? key
    await this.#db
      .insert(sessionCommands)
      .values({ sessionId, key, conversationId, clientSeq })
      .onConflictDoUpdate({
        target: [sessionCommands.key, sessionCommands.conversationId],
        set: { clientSeq: sql`GREATEST(${sessionCommands.clientSeq}, excluded.client_seq)` },
      })
  }
}
