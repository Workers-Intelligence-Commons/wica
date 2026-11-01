// Conversation index on D1: the list of conversations, their owner or guest, title, model, salt,
// trash and gift to the commons. The head and the time of the last change are copied from the
// journal after each turn.

import { and, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm'

import type { ConversationIndex, Owner } from '../data.ts'
import { randomSalt, uuidv7 } from '../ids.ts'
import type { D1Db } from './accounts.ts'
import { conversations as c } from './schema.ts'

export type D1ConversationIndex = ConversationIndex & {
  /** Copies the head of the journal into the list, and marks the conversation as changed. */
  recordHead(conversationId: string, head: string | null): Promise<void>
}

const ownedBy = (owner: Owner) =>
  owner.kind === 'user' ? eq(c.ownerId, owner.id) : and(isNull(c.ownerId), eq(c.guestId, owner.id))

const nowIso = () => new Date().toISOString()

export const d1ConversationIndex = (db: D1Db): D1ConversationIndex => ({
  async create({ owner, title, model }) {
    const id = uuidv7()
    const salt = randomSalt()
    await db.insert(c).values({
      id,
      ...(owner.kind === 'user' ? { ownerId: owner.id } : { guestId: owner.id }),
      title,
      model,
      idSalt: salt,
    })
    return { id, salt }
  },

  async get(conversationId) {
    const [row] = await db
      .select({
        id: c.id,
        ownerId: c.ownerId,
        model: c.model,
        salt: c.idSalt,
        deletedAt: c.deletedAt,
        contributedAt: c.contributedAt,
        guestId: c.guestId,
      })
      .from(c)
      .where(eq(c.id, conversationId))
    if (!row) return null
    const { deletedAt, contributedAt, ...entry } = row
    return { ...entry, trashed: deletedAt !== null, contributed: contributedAt !== null }
  },

  async setTitleIfEmpty(conversationId, title) {
    await db
      .update(c)
      .set({ title })
      .where(and(eq(c.id, conversationId), eq(c.title, '')))
  },

  async setTitle(conversationId, title) {
    await db.update(c).set({ title }).where(eq(c.id, conversationId))
  },

  async setModel(conversationId, model) {
    await db.update(c).set({ model }).where(eq(c.id, conversationId))
  },

  async markContributed(conversationId) {
    await db
      .update(c)
      .set({ contributedAt: nowIso() })
      .where(and(eq(c.id, conversationId), isNull(c.contributedAt)))
  },

  async trash(conversationId) {
    await db
      .update(c)
      .set({ deletedAt: nowIso() })
      .where(and(eq(c.id, conversationId), isNull(c.deletedAt)))
  },

  async restore(conversationId) {
    await db.update(c).set({ deletedAt: null }).where(eq(c.id, conversationId))
  },

  async giveToCommons(conversationId) {
    await db
      .update(c)
      .set({ ownerId: null, guestId: null, deletedAt: null })
      .where(eq(c.id, conversationId))
  },

  async trashedBefore(before) {
    const rows = await db
      .select({ id: c.id })
      .from(c)
      .where(and(isNotNull(c.deletedAt), lt(c.deletedAt, before)))
    return rows.map((r) => r.id)
  },

  async guestsIdleSince(before) {
    const rows = await db
      .select({ id: c.id })
      .from(c)
      .where(and(isNull(c.ownerId), isNotNull(c.guestId), lt(c.updatedAt, before)))
    return rows.map((r) => r.id)
  },

  async claim(guestId, userId) {
    await db
      .update(c)
      .set({ ownerId: userId, guestId: null })
      .where(and(isNull(c.ownerId), eq(c.guestId, guestId)))
  },

  async list(owner) {
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
        contributed_at: c.contributedAt,
        deleted_at: c.deletedAt,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      })
      .from(c)
      .where(ownedBy(owner))
      .orderBy(desc(c.updatedAt))
  },

  async delete(conversationId) {
    await db.delete(c).where(eq(c.id, conversationId))
  },

  async recordHead(conversationId, head) {
    await db
      .update(c)
      .set({ headItemId: head, updatedAt: nowIso() })
      .where(eq(c.id, conversationId))
  },
})
