// Compose scheduler: a wake-up is a row of `wakeups`, which the application process claims for
// its turn, with a short claim extended as long as the turn runs. A row is deleted only after its
// turn: a process stop in the middle of a turn leaves it in place, and it becomes due again as
// soon as its claim ends.

import type { Scheduler } from '@wica/runtime'
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import type { Db } from './db.ts'
import { wakeups } from './schema.ts'

const after = (ms: unknown) => sql`now() + ${ms} * interval '1 millisecond'`

export function pgScheduler(db: Db) {
  const scheduler: Scheduler = {
    async wake(conversationId, options = {}) {
      // While a turn holds the row, the requested wake-up waits in `rearm_at`.
      const held = sql`${wakeups.claimedUntil} > now()`
      await db
        .insert(wakeups)
        .values({ conversationId, dueAt: after(options.afterMs ?? 0) })
        .onConflictDoUpdate({
          target: wakeups.conversationId,
          set: {
            dueAt: sql`CASE WHEN ${held} THEN ${wakeups.dueAt}
                            ELSE LEAST(${wakeups.dueAt}, excluded.due_at) END`,
            rearmAt: sql`CASE WHEN ${held}
                              THEN LEAST(COALESCE(${wakeups.rearmAt}, excluded.due_at), excluded.due_at)
                              ELSE ${wakeups.rearmAt} END`,
          },
        })
    },
  }

  /** Claims up to `limit` due wake-ups, for at most `claimMs`. */
  async function due(limit: number, claimMs: number) {
    const ready = db
      .select({ id: wakeups.conversationId })
      .from(wakeups)
      .where(
        and(
          lte(wakeups.dueAt, sql`now()`),
          or(isNull(wakeups.claimedUntil), lte(wakeups.claimedUntil, sql`now()`)),
        ),
      )
      .orderBy(asc(wakeups.dueAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    return db
      .update(wakeups)
      .set({ claimedUntil: after(claimMs) })
      .where(inArray(wakeups.conversationId, ready))
      .returning({ conversationId: wakeups.conversationId })
  }

  async function extend(conversationId: string, claimMs: number) {
    await db
      .update(wakeups)
      .set({ claimedUntil: after(claimMs) })
      .where(eq(wakeups.conversationId, conversationId))
  }

  /** End of a turn: the row disappears, or becomes the wake-up requested during the turn. */
  async function done(conversationId: string) {
    await db.transaction(async (tx) => {
      await tx
        .delete(wakeups)
        .where(and(eq(wakeups.conversationId, conversationId), isNull(wakeups.rearmAt)))
      await tx
        .update(wakeups)
        .set({ dueAt: sql`${wakeups.rearmAt}`, rearmAt: null, claimedUntil: null })
        .where(eq(wakeups.conversationId, conversationId))
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
      for (const { conversationId } of rows) {
        running += 1
        const renewal = setInterval(
          () => void extend(conversationId, claimMs).catch(() => {}),
          claimMs / 3,
        )
        void handler(conversationId)
          .catch(() => {})
          .finally(() => clearInterval(renewal))
          .then(() => done(conversationId))
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
