// Conversation host of Compose: each command is written to `commands`, processed in the request
// by a short turn, and its acknowledgement kept there, so a replay of the same identifier gets
// the same answer. The rest of a turn leaves as a wake-up of the `wakeups` loop.

import type { Envelope } from '@wica/protocol'
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'

import type { ConversationHost } from '../data.ts'
import type { ConversationTurns } from '../turns.ts'
import type { Db } from './db.ts'
import {
  blobs,
  commands,
  conversations,
  conversationWriters,
  itemChunks,
  items,
  snapshots,
  toolClaims,
  wakeups,
} from './schema.ts'

type Ack = { ok: true } | { ok: false; error: string }

export function pgConversationHost(db: Db, turns: ConversationTurns): ConversationHost {
  return {
    async command(envelope: Envelope, from) {
      const [inserted] = await db
        .insert(commands)
        .values({
          id: envelope.commandId,
          conversationId: envelope.conversationId,
          kind: envelope.command.t,
          payload: envelope,
        })
        .onConflictDoNothing()
        .returning({ id: commands.id })
      if (!inserted) {
        const [existing] = await db
          .select({ ack: commands.ack, conversationId: commands.conversationId })
          .from(commands)
          .where(eq(commands.id, envelope.commandId))
        if (existing?.conversationId !== envelope.conversationId) return { kind: 'conflict' }
        if (existing.ack) return { kind: 'acked', ack: existing.ack as Ack }
      }
      const { ack, sessionId } = await turns.run(envelope, from)
      await db
        .update(commands)
        .set({ ackedAt: sql`now()`, ack })
        .where(eq(commands.id, envelope.commandId))
      return { kind: 'acked', ack, sessionId }
    },

    wake: turns.wake,

    async read(conversationId) {
      const [conversation] = await db
        .select({ head: conversations.headItemId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
      const rows = await db
        .select({
          conversation_id: items.conversationId,
          id: items.id,
          parent_id: items.parentId,
          seq: items.seq,
          kind: items.kind,
          payload: items.payload,
          status: items.status,
        })
        .from(items)
        .where(eq(items.conversationId, conversationId))
        .orderBy(asc(items.seq))
      const streaming = rows.filter((r) => r.status === 'streaming').map((r) => r.id)
      const chunks =
        streaming.length === 0
          ? []
          : await db
              .select({
                conversation_id: itemChunks.conversationId,
                item_id: itemChunks.itemId,
                idx: itemChunks.idx,
                text: itemChunks.text,
              })
              .from(itemChunks)
              .where(
                and(
                  eq(itemChunks.conversationId, conversationId),
                  inArray(itemChunks.itemId, streaming),
                ),
              )
      return {
        head: conversation?.head ?? null,
        items: rows.map((r) => ({ ...r, payload: r.payload as Record<string, unknown> })),
        chunks,
      }
    },

    async erase(conversationId) {
      await db.transaction(async (tx) => {
        await tx.delete(items).where(eq(items.conversationId, conversationId))
        for (const table of [snapshots, toolClaims, commands, wakeups, conversationWriters]) {
          await tx.delete(table).where(eq(table.conversationId, conversationId))
        }
        // Garbage collection: a blob that no item references anymore is freed.
        await tx.delete(blobs).where(
          notExists(
            tx
              .select({ one: sql`1` })
              .from(items)
              .where(eq(items.blobSha256, blobs.sha256)),
          ),
        )
      })
    },
  }
}
