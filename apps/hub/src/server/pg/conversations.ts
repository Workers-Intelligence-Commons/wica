// Conversation index on Postgres: the `conversations` rows that the routes own (owner or guest,
// title, model, salt, trash, gift to the commons). The journal columns of the same table belong to
// the `Store`.

import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'

import type { ConversationIndex, Owner } from '../data.ts'
import { randomSalt, uuidv7 } from '../ids.ts'
import type { Db } from './db.ts'
import { conversations as c } from './schema.ts'

const text = (column: unknown) => sql<string>`${column}::text`

const ownedBy = (owner: Owner) =>
  owner.kind === 'user' ? eq(c.ownerId, owner.id) : and(isNull(c.ownerId), eq(c.guestId, owner.id))

export const pgConversationIndex = (db: Db): ConversationIndex => ({
  async create({ owner, title, model }) {
    const id = uuidv7()
    const salt = randomSalt()
    // The transaction identifier lets Electric's client wait for this row in the sync.
    const txid = await db.transaction(async (tx) => {
      await tx.insert(c).values({
        id,
        ...(owner.kind === 'user' ? { ownerId: owner.id } : { guestId: owner.id }),
        title,
        model,
        idSalt: salt,
      })
      const [row] = await tx.execute<{ txid: string }>(
        sql`SELECT pg_current_xact_id()::xid::text AS txid`,
      )
      return Number(row?.txid)
    })
    return { id, salt, txid }
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
      .set({ contributedAt: sql`now()` })
      .where(and(eq(c.id, conversationId), isNull(c.contributedAt)))
  },

  async trash(conversationId) {
    await db
      .update(c)
      .set({ deletedAt: sql`now()` })
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
      .where(and(isNotNull(c.deletedAt), lt(c.deletedAt, new Date(before))))
    return rows.map((r) => r.id)
  },

  async guestsIdleSince(before) {
    const rows = await db
      .select({ id: c.id })
      .from(c)
      .where(and(isNull(c.ownerId), isNotNull(c.guestId), lt(c.updatedAt, new Date(before))))
    return rows.map((r) => r.id)
  },

  async claim(guestId, to) {
    await db
      .update(c)
      .set(to.kind === 'user' ? { ownerId: to.id, guestId: null } : { guestId: to.id })
      .where(and(isNull(c.ownerId), eq(c.guestId, guestId)))
  },

  async list(owner) {
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
        contributed_at: sql<string | null>`${c.contributedAt}::text`,
        deleted_at: sql<string | null>`${c.deletedAt}::text`,
        created_at: text(c.createdAt),
        updated_at: text(c.updatedAt),
      })
      .from(c)
      .where(ownedBy(owner))
      .orderBy(desc(c.updatedAt))
  },

  async delete(conversationId) {
    await db.delete(c).where(eq(c.id, conversationId))
  },
})
