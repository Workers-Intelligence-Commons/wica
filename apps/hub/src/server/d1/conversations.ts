// Conversation index on D1: the list of conversations, their owner, title, model and salt. The
// head and the time of the last change are copied from the journal after each turn.

import { and, desc, eq } from 'drizzle-orm'

import type { ConversationIndex } from '../data.ts'
import { randomSalt, uuidv7 } from '../ids.ts'
import type { D1Db } from './accounts.ts'
import { conversations as c } from './schema.ts'

export type D1ConversationIndex = ConversationIndex & {
  /** Copies the head of the journal into the list, and marks the conversation as changed. */
  recordHead(conversationId: string, head: string | null): Promise<void>
}

export const d1ConversationIndex = (db: D1Db): D1ConversationIndex => ({
  async create({ ownerId, title, model }) {
    const id = uuidv7()
    const salt = randomSalt()
    await db.insert(c).values({ id, ownerId, title, model, idSalt: salt })
    return { id, salt }
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
        owner_id: c.ownerId,
        organization_id: c.organizationId,
        parent_conversation_id: c.parentConversationId,
        parent_call_id: c.parentCallId,
        title: c.title,
        model: c.model,
        head_item_id: c.headItemId,
        id_salt: c.idSalt,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      })
      .from(c)
      .where(eq(c.ownerId, ownerId))
      .orderBy(desc(c.updatedAt))
  },

  async delete(conversationId) {
    await db.delete(c).where(eq(c.id, conversationId))
  },

  async recordHead(conversationId, head) {
    await db
      .update(c)
      .set({ headItemId: head, updatedAt: new Date().toISOString() })
      .where(eq(c.id, conversationId))
  },
})
