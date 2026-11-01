// People's model token rows on Postgres, one current row per provider. The lease is taken by one
// conditional statement on `refreshing_until`, so no transaction stays open during a refresh.

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'

import type { ModelTokenRows } from '../data.ts'
import type { Db } from './db.ts'
import { modelCredentials as tokens } from './schema.ts'

const current = (userId: string, provider: string) =>
  and(eq(tokens.userId, userId), eq(tokens.provider, provider), isNull(tokens.revokedAt))

const sealed = { ciphertext: tokens.ciphertext, key_id: tokens.keyId }

export const pgTokenRows = (db: Db): ModelTokenRows => ({
  async current(userId, provider) {
    const [row] = await db.select(sealed).from(tokens).where(current(userId, provider))
    return row ?? null
  },

  async list(userId) {
    const rows = await db
      .select({ provider: tokens.provider, kind: tokens.kind })
      .from(tokens)
      .where(and(eq(tokens.userId, userId), isNull(tokens.revokedAt)))
    return rows.map((r) => ({ providerId: r.provider, type: r.kind }))
  },

  async lease(userId, provider, until, now) {
    const [held] = await db
      .update(tokens)
      .set({ refreshingUntil: until })
      .where(
        and(
          current(userId, provider),
          or(isNull(tokens.refreshingUntil), lte(tokens.refreshingUntil, now)),
        ),
      )
      .returning({ id: tokens.id, ...sealed })
    if (held) return { id: held.id, secret: { ciphertext: held.ciphertext, key_id: held.key_id } }
    const [exists] = await db
      .select({ id: tokens.id })
      .from(tokens)
      .where(current(userId, provider))
    return exists ? 'busy' : 'missing'
  },

  async release(id, until, change) {
    await db
      .update(tokens)
      .set({
        ...(change
          ? { ciphertext: change.secret.ciphertext, keyId: change.secret.key_id, kind: change.type }
          : {}),
        refreshingUntil: sql`CASE WHEN ${tokens.refreshingUntil} = ${until} THEN NULL
                                  ELSE ${tokens.refreshingUntil} END`,
      })
      .where(eq(tokens.id, id))
  },

  async insert(userId, provider, type, secret) {
    const inserted = await db
      .insert(tokens)
      .values({
        id: crypto.randomUUID(),
        userId,
        provider,
        kind: type,
        ciphertext: secret.ciphertext,
        keyId: secret.key_id,
      })
      .onConflictDoNothing()
      .returning({ id: tokens.id })
    return inserted.length > 0
  },

  async revoke(userId, provider) {
    await db
      .update(tokens)
      .set({ revokedAt: sql`now()` })
      .where(current(userId, provider))
  },

  async markWarned(userId, provider) {
    const updated = await db
      .update(tokens)
      .set({ warnedAt: sql`now()` })
      .where(and(current(userId, provider), isNull(tokens.warnedAt)))
      .returning({ id: tokens.id })
    return updated.length > 0
  },
})
