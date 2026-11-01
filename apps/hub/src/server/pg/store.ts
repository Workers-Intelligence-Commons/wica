// Harness `Store` on Postgres. The fencing token and the lease live in `conversation_writers`,
// which the sync does not see; each write checks the `epoch` and extends the lease in the same
// transaction, and reads the interruption request there.

import type { ItemDraft, Part } from '@wica/core'
import { type Claim, type Snapshot, StaleEpochError, type Store } from '@wica/runtime'
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'

import { draftToRow, restoreItem, rowToItem } from '../../shared/rows.ts'
import { randomSalt } from '../ids.ts'
import type { Db, Query, Tx } from './db.ts'
import {
  blobs,
  conversationWriters as writers,
  conversations,
  itemChunks,
  items,
  snapshots,
  toolClaims,
} from './schema.ts'

/** Creates the conversation and its write state if they are missing. */
async function ensure(db: Query, conversationId: string) {
  await db
    .insert(conversations)
    .values({ id: conversationId, idSalt: randomSalt() })
    .onConflictDoNothing()
  await db.insert(writers).values({ conversationId }).onConflictDoNothing()
}

const leaseFrom = (ms: unknown) => sql`now() + ${ms} * interval '1 millisecond'`

/**
 * Checks the `epoch`, extends the lease and locks the row until the end of the transaction: two
 * writes of the same conversation follow each other there, so the `seq` values do not cross.
 */
async function fence(tx: Tx, conversationId: string, epoch: number) {
  const [row] = await tx
    .update(writers)
    .set({
      leaseUntil: sql`CASE WHEN ${writers.leaseMs} IS NULL THEN NULL
                           ELSE ${leaseFrom(writers.leaseMs)} END`,
    })
    .where(and(eq(writers.conversationId, conversationId), eq(writers.writerEpoch, epoch)))
    .returning({
      lastSeq: writers.lastSeq,
      interrupt: sql<boolean>`${writers.interruptRequestedAt} IS NOT NULL`,
    })
  if (!row) throw new StaleEpochError(`epoch ${epoch} is stale for ${conversationId}`)
  return row
}

export class PgStore implements Store {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async claim(conversationId: string, leaseMs: number): Promise<Claim> {
    return this.#db.transaction(async (tx) => {
      await ensure(tx, conversationId)
      const [claimed] = await tx
        .update(writers)
        .set({
          writerEpoch: sql`${writers.writerEpoch} + 1`,
          leaseUntil: leaseFrom(leaseMs),
          leaseMs,
        })
        .where(
          and(
            eq(writers.conversationId, conversationId),
            or(isNull(writers.leaseUntil), lte(writers.leaseUntil, sql`now()`)),
          ),
        )
        .returning({ epoch: writers.writerEpoch })
      if (claimed) return { epoch: claimed.epoch }
      const [busy] = await tx
        .select({
          ms: sql<number>`GREATEST(1, CEIL(EXTRACT(EPOCH FROM ${writers.leaseUntil} - now()) * 1000))::int`,
        })
        .from(writers)
        .where(eq(writers.conversationId, conversationId))
      return { busyForMs: busy?.ms ?? 1 }
    })
  }

  async renew(conversationId: string, epoch: number) {
    await this.#db.transaction((tx) => fence(tx, conversationId, epoch))
  }

  async release(conversationId: string, epoch: number) {
    await this.#db
      .update(writers)
      .set({ leaseUntil: null, leaseMs: null })
      .where(and(eq(writers.conversationId, conversationId), eq(writers.writerEpoch, epoch)))
  }

  async load(conversationId: string, fromSeq: number) {
    await ensure(this.#db, conversationId)
    const [conversation] = await this.#db
      .select({
        salt: conversations.idSalt,
        head: conversations.headItemId,
        interrupt: sql<boolean>`${writers.interruptRequestedAt} IS NOT NULL`,
      })
      .from(conversations)
      .innerJoin(writers, eq(writers.conversationId, conversations.id))
      .where(eq(conversations.id, conversationId))
    // A streaming item carries the text of its batches, joined back in the order of `idx`.
    const rows = await this.#db
      .select({
        id: items.id,
        parent_id: items.parentId,
        seq: items.seq,
        status: items.status,
        payload: items.payload,
        blob: blobs.data,
        live: sql<string | null>`CASE WHEN ${items.status} = 'streaming' THEN (
          SELECT string_agg(k.text, '' ORDER BY k.idx) FROM ${itemChunks} k
          WHERE k.conversation_id = ${items.conversationId} AND k.item_id = ${items.id}) END`,
      })
      .from(items)
      .leftJoin(blobs, eq(blobs.sha256, items.blobSha256))
      // The Harness asks for "everything after" with the largest safe integer, beyond `integer`.
      .where(and(eq(items.conversationId, conversationId), gt(items.seq, sql`${fromSeq}::bigint`)))
      .orderBy(asc(items.seq))
    return {
      salt: conversation?.salt ?? '',
      head: conversation?.head ?? null,
      items: rows.map((row) => {
        const item = restoreItem(
          rowToItem({ ...row, payload: row.payload as Record<string, unknown> }),
          (row.blob as Part[] | null) ?? undefined,
        )
        return row.live !== null && (item.kind === 'assistant_text' || item.kind === 'reasoning')
          ? { ...item, text: row.live }
          : item
      }),
      interruptRequested: conversation?.interrupt ?? false,
    }
  }

  async append(conversationId: string, drafts: ItemDraft[], epoch: number) {
    return this.#db.transaction(async (tx) => {
      const writer = await fence(tx, conversationId, epoch)
      let seq = writer.lastSeq
      const persisted: { id: string; seq: number }[] = []
      for (const draft of drafts) {
        const { payload, blob } = draftToRow(draft)
        if (blob) {
          await tx
            .insert(blobs)
            .values({ sha256: blob.sha256, data: blob.output })
            .onConflictDoNothing()
        }
        const [inserted] = await tx
          .insert(items)
          .values({
            conversationId,
            id: draft.id,
            parentId: draft.parentId,
            seq: seq + 1,
            kind: draft.kind,
            payload,
            status: draft.status,
            blobSha256: blob?.sha256 ?? null,
          })
          .onConflictDoNothing({ target: [items.conversationId, items.id] })
          .returning({ seq: items.seq })
        if (inserted) {
          seq = inserted.seq
          persisted.push({ id: draft.id, seq })
          continue
        }
        const [existing] = await tx
          .select({ seq: items.seq })
          .from(items)
          .where(and(eq(items.conversationId, conversationId), eq(items.id, draft.id)))
        persisted.push({ id: draft.id, seq: existing?.seq ?? 0 })
      }
      await tx
        .update(writers)
        .set({ lastSeq: seq })
        .where(eq(writers.conversationId, conversationId))
      const last = drafts.at(-1)
      if (last) {
        await tx
          .update(conversations)
          .set({ headItemId: last.id, updatedAt: sql`now()` })
          .where(eq(conversations.id, conversationId))
      }
      return { persisted, interruptRequested: writer.interrupt }
    })
  }

  async appendBatch(
    conversationId: string,
    itemId: string,
    idx: number,
    text: string,
    epoch: number,
  ) {
    return this.#db.transaction(async (tx) => {
      const writer = await fence(tx, conversationId, epoch)
      await tx
        .insert(itemChunks)
        .values({ conversationId, itemId, idx, text })
        .onConflictDoNothing()
      return { interruptRequested: writer.interrupt }
    })
  }

  async settle(conversationId: string, final: ItemDraft, epoch: number) {
    await this.#db.transaction(async (tx) => {
      await fence(tx, conversationId, epoch)
      const { payload } = draftToRow(final)
      const updated = await tx
        .update(items)
        .set({ payload, status: final.status })
        .where(and(eq(items.conversationId, conversationId), eq(items.id, final.id)))
        .returning({ id: items.id })
      if (updated.length === 0) throw new Error(`unknown item: ${final.id}`)
      await tx
        .delete(itemChunks)
        .where(and(eq(itemChunks.conversationId, conversationId), eq(itemChunks.itemId, final.id)))
    })
  }

  async setHead(conversationId: string, itemId: string, epoch: number) {
    await this.#db.transaction(async (tx) => {
      await fence(tx, conversationId, epoch)
      await tx
        .update(conversations)
        .set({ headItemId: itemId, updatedAt: sql`now()` })
        .where(eq(conversations.id, conversationId))
    })
  }

  async requestInterrupt(conversationId: string) {
    await ensure(this.#db, conversationId)
    await this.#db
      .update(writers)
      .set({ interruptRequestedAt: sql`now()` })
      .where(eq(writers.conversationId, conversationId))
  }

  async clearInterrupt(conversationId: string, epoch: number) {
    await this.#db.transaction(async (tx) => {
      await fence(tx, conversationId, epoch)
      await tx
        .update(writers)
        .set({ interruptRequestedAt: null })
        .where(eq(writers.conversationId, conversationId))
    })
  }

  async claimToolCall(conversationId: string, callId: string, epoch: number) {
    return this.#db.transaction(async (tx) => {
      await fence(tx, conversationId, epoch)
      await tx.insert(toolClaims).values({ conversationId, callId, epoch }).onConflictDoNothing()
      const [owner] = await tx
        .select({ epoch: toolClaims.epoch })
        .from(toolClaims)
        .where(and(eq(toolClaims.conversationId, conversationId), eq(toolClaims.callId, callId)))
      return owner?.epoch === epoch ? ('claimed' as const) : ('already_claimed' as const)
    })
  }

  async loadSnapshot(conversationId: string): Promise<Snapshot | undefined> {
    const [row] = await this.#db
      .select({ data: snapshots.data })
      .from(snapshots)
      .where(eq(snapshots.conversationId, conversationId))
    return row?.data as Snapshot | undefined
  }

  async saveSnapshot(conversationId: string, snapshot: Snapshot, epoch: number) {
    await this.#db.transaction(async (tx) => {
      await fence(tx, conversationId, epoch)
      await tx
        .insert(snapshots)
        .values({ conversationId, data: snapshot })
        .onConflictDoUpdate({ target: snapshots.conversationId, set: { data: snapshot } })
    })
  }
}
