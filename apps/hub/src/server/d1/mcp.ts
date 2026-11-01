// The tool server catalog and the tool servers of each account, on D1.

import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm'

import { uuidv7 } from '../ids.ts'
import type { McpConnection, McpServers, SealedSecret } from '../data.ts'
import type { D1Db } from './accounts.ts'
import { mcpCatalog as catalog, mcpConnections as connections } from './schema.ts'

const entry = {
  id: catalog.id,
  name: catalog.name,
  url: catalog.url,
  description: catalog.description,
}

const connection = {
  id: connections.id,
  userId: connections.userId,
  name: connections.name,
  url: connections.url,
  catalogId: connections.catalogId,
  auth: connections.auth,
  status: connections.status,
}

const sealed = (row: { ciphertext: string | null; keyId: string | null }): SealedSecret | null =>
  row.ciphertext && row.keyId ? { ciphertext: row.ciphertext, key_id: row.keyId } : null

const columns = (secret: SealedSecret | null) => ({
  ciphertext: secret?.ciphertext ?? null,
  keyId: secret?.key_id ?? null,
})

export const d1McpServers = (db: D1Db): McpServers => ({
  catalog: () => db.select(entry).from(catalog).orderBy(asc(catalog.name)),

  async catalogEntry(id) {
    const [row] = await db.select(entry).from(catalog).where(eq(catalog.id, id))
    return row ?? null
  },

  async addToCatalog(input) {
    const [row] = await db
      .insert(catalog)
      .values({ id: uuidv7(), ...input })
      .onConflictDoNothing()
      .returning(entry)
    return row ?? 'name_taken'
  },

  async removeFromCatalog(id) {
    await db.delete(catalog).where(eq(catalog.id, id))
  },

  connections: (userId) =>
    db
      .select(connection)
      .from(connections)
      .where(eq(connections.userId, userId))
      .orderBy(asc(connections.name)),

  async connection(id) {
    const [row] = await db
      .select({ ...connection, ciphertext: connections.ciphertext, keyId: connections.keyId })
      .from(connections)
      .where(eq(connections.id, id))
    if (!row) return null
    const { ciphertext, keyId, ...rest } = row
    return { ...rest, secret: sealed({ ciphertext, keyId }) }
  },

  async connect({ secret, ...input }) {
    const [row] = await db
      .insert(connections)
      .values({ id: uuidv7(), ...input, ...columns(secret) })
      .onConflictDoNothing()
      .returning(connection)
    return (row as McpConnection | undefined) ?? 'name_taken'
  },

  async rename(userId, id, name) {
    const [other] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(eq(connections.userId, userId), eq(connections.name, name), ne(connections.id, id)),
      )
    if (other) return 'name_taken'
    const renamed = await db
      .update(connections)
      .set({ name })
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      .returning({ id: connections.id })
    return renamed.length > 0
  },

  async disconnect(userId, id) {
    const removed = await db
      .delete(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      .returning({ id: connections.id })
    return removed.length > 0
  },

  async save(id, { secret, status }) {
    await db
      .update(connections)
      .set({ ...columns(secret), status })
      .where(eq(connections.id, id))
  },

  async lease(id, until, now) {
    const [held] = await db
      .update(connections)
      .set({ refreshingUntil: until })
      .where(
        and(
          eq(connections.id, id),
          or(isNull(connections.refreshingUntil), lte(connections.refreshingUntil, now)),
        ),
      )
      .returning({ ciphertext: connections.ciphertext, keyId: connections.keyId })
    if (held) return { secret: sealed(held) }
    const [exists] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.id, id))
    return exists ? 'busy' : 'missing'
  },

  async release(id, until, change) {
    // The expressions read the row as it was before this statement.
    const held = sql`${connections.refreshingUntil} = ${until}`
    await db
      .update(connections)
      .set({
        ...(change?.status === 'connected'
          ? { ...columns(change.secret), status: change.status }
          : {}),
        ...(change?.status === 'sign_in'
          ? { status: sql`CASE WHEN ${held} THEN 'sign_in' ELSE ${connections.status} END` }
          : {}),
        refreshingUntil: sql`CASE WHEN ${held} THEN NULL ELSE ${connections.refreshingUntil} END`,
      })
      .where(eq(connections.id, id))
  },
})
