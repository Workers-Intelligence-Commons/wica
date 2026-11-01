// Conversation index on Postgres: the `conversations` rows that the routes own (owner, title,
// model, salt). The journal columns of the same table belong to the `Store`.

import { and, desc, eq, sql } from 'drizzle-orm'

import type { ConversationIndex } from '../data.ts'
import { randomSalt, uuidv7 } from '../ids.ts'
import type { Db } from './db.ts'
import { conversations as c } from './schema.ts'

const text = (column: unknown) => sql<string>`${column}::text`

export const pgConversationIndex = (db: Db): ConversationIndex => ({
  async create({ ownerId, title, model }) {
    const id = uuidv7()
    const salt = randomSalt()
    // The transaction identifier lets Electric's client wait for this row in the sync.
    const txid = await db.transaction(async (tx) => {
      await tx.insert(c).values({ id, ownerId, title, model, idSalt: salt })
      const [row] = await tx.execute<{ txid: string }>(
        sql`SELECT pg_current_xact_id()::xid::text AS txid`,
      )
      return Number(row?.txid)
    })
    return { id, salt, txid }
  },

  async get(conversationId) {
    const [row] = await db
      .select({ id: c.id, ownerId: c.ownerId, model: c.model, salt: c.idSalt })
      .from(c)
      .where(eq(c.id, conversationId))
    return row ?? null
  },

  async setTitleIfEmpty(conversationId, title) {
    await db
      .update(c)
      .set({ title })
      .where(and(eq(c.id, conversationId), eq(c.title, '')))
  },

  async list(ownerId) {
    return db
      .select({
        id: c.id,
        owner_id: sql<string>`${c.ownerId}`,
        organization_id: c.organizationId,
        parent_conversation_id: c.parentConversationId,
        parent_call_id: c.parentCallId,
        title: c.title,
        model: c.model,
        head_item_id: c.headItemId,
        id_salt: c.idSalt,
        created_at: text(c.createdAt),
        updated_at: text(c.updatedAt),
      })
      .from(c)
      .where(eq(c.ownerId, ownerId))
      .orderBy(desc(c.updatedAt))
  },

  async delete(conversationId) {
    await db.delete(c).where(eq(c.id, conversationId))
  },
})
