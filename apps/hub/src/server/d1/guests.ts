// Guest keys and their daily counts on D1.

import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm'

import type { Guests } from '../data.ts'
import { uuidv7 } from '../ids.ts'
import type { D1Db } from './accounts.ts'
import { conversations, guestUsage, guests } from './schema.ts'

export const d1Guests = (db: D1Db): Guests => ({
  async create(secretHash) {
    const id = uuidv7()
    await db.insert(guests).values({ id, secretHash })
    return id
  },

  async verify(id, secretHash) {
    const [row] = await db
      .select({ id: guests.id })
      .from(guests)
      .where(and(eq(guests.id, id), eq(guests.secretHash, secretHash)))
    return Boolean(row)
  },

  async delete(id) {
    await db.delete(guests).where(eq(guests.id, id))
  },

  async prune(before, beforeDay) {
    await db
      .delete(guests)
      .where(
        and(
          lt(guests.createdAt, before),
          notExists(
            db
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.guestId, guests.id)),
          ),
        ),
      )
    await db.delete(guestUsage).where(lt(guestUsage.day, beforeDay))
  },

  // D1 has no row lock: two messages that arrive at the same moment may both pass a limit that
  // only one of them had left.
  async count(keys, day, limit) {
    const rows = await db
      .select({ count: guestUsage.count })
      .from(guestUsage)
      .where(and(inArray(guestUsage.key, keys), eq(guestUsage.day, day)))
    if (rows.some((r) => r.count >= limit)) return false
    await db.batch(
      keys.map((key) =>
        db
          .insert(guestUsage)
          .values({ key, day, count: 1 })
          .onConflictDoUpdate({
            target: [guestUsage.key, guestUsage.day],
            set: { count: sql`${guestUsage.count} + 1` },
          }),
      ) as [never, ...never[]],
    )
    return true
  },
})
