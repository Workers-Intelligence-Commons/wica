// Harness `Store` on the SQLite database of one conversation's Durable Object. The write state
// sits in the single `conversation` row; each write checks the `epoch` and extends the lease in
// the same transaction. Once a write is committed, its rows leave as live frames for the sockets
// of the conversation.

import type { ItemDraft, Part, ReasoningLevel } from '@wica/core'
import { type Claim, type Snapshot, StaleEpochError, type Store } from '@wica/runtime'
import { asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'

import type { LiveFrame } from '../../shared/live.ts'
import {
  type ChunkRow,
  draftToRow,
  type ItemShapeRow,
  type ModelCallRow,
  restoreItem,
  rowToItem,
} from '../../shared/rows.ts'
import {
  commands,
  conversation,
  itemChunks,
  items,
  modelCalls,
  snapshot,
  toolClaims,
} from './schema.ts'

export type DoDb = DrizzleSqliteDODatabase
type Tx = Parameters<Parameters<DoDb['transaction']>[0]>[0]

const itemColumns = {
  id: items.id,
  parent_id: items.parentId,
  seq: items.seq,
  kind: items.kind,
  payload: items.payload,
  status: items.status,
}

/**
 * Checks the `epoch` and extends the lease; the transaction of the Durable Object runs alone, so
 * two writes do not cross.
 */
function fence(tx: Tx, epoch: number) {
  const row = tx
    .update(conversation)
    .set({
      leaseUntil: sql`CASE WHEN ${conversation.leaseMs} IS NULL THEN NULL
                           ELSE ${Date.now()} + ${conversation.leaseMs} END`,
    })
    .where(eq(conversation.writerEpoch, epoch))
    .returning({ lastSeq: conversation.lastSeq, interrupt: conversation.interruptRequested })
    .get()
  if (!row) throw new StaleEpochError(`epoch ${epoch} is stale`)
  return row
}

/** The conversation this database holds, and its head; `undefined` before its first write. */
export const storedConversation = (db: DoDb) =>
  db.select({ id: conversation.id, head: conversation.headItemId }).from(conversation).get()

/** Rows of the journal as the browser holds them: every item, and the batches still streaming. */
export function journalRows(db: DoDb, conversationId: string) {
  const head = db.select({ head: conversation.headItemId }).from(conversation).get()?.head ?? null
  const rows = db.select(itemColumns).from(items).orderBy(asc(items.seq)).all()
  const streaming = rows.filter((r) => r.status === 'streaming').map((r) => r.id)
  const chunks: ChunkRow[] =
    streaming.length === 0
      ? []
      : db
          .select({ item_id: itemChunks.itemId, idx: itemChunks.idx, text: itemChunks.text })
          .from(itemChunks)
          .where(inArray(itemChunks.itemId, streaming))
          .orderBy(asc(itemChunks.itemId), asc(itemChunks.idx))
          .all()
          .map((c) => ({ conversation_id: conversationId, ...c }))
  const shaped: ItemShapeRow[] = rows.map((r) => ({ conversation_id: conversationId, ...r }))
  const calls: ModelCallRow[] = db
    .select()
    .from(modelCalls)
    .orderBy(asc(modelCalls.startedAt))
    .all()
    .map((r) => ({
      conversation_id: conversationId,
      id: r.id,
      item_ids: r.itemIds,
      model: r.model,
      model_name: r.modelName,
      started_at: r.startedAt,
      first_token_ms: r.firstTokenMs,
      duration_ms: r.durationMs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_write_tokens: r.cacheWriteTokens,
      reasoning: r.reasoning as ReasoningLevel | null,
    }))
  return { head, items: shaped, chunks, calls }
}

export class DoStore implements Store {
  readonly #db: DoDb
  readonly #salt: (conversationId: string) => Promise<string>
  readonly #emit: (frame: LiveFrame) => void

  /**
   * `salt` gives the identifier salt of the conversation the first time its row is created;
   * `emit` receives the frames of each committed write.
   */
  constructor(
    db: DoDb,
    salt: (conversationId: string) => Promise<string>,
    emit: (frame: LiveFrame) => void,
  ) {
    this.#db = db
    this.#salt = salt
    this.#emit = emit
  }

  /** Keeps a completed model call, then sends it to the sockets of the conversation. */
  async recordCall(call: ModelCallRow) {
    this.#db
      .insert(modelCalls)
      .values({
        id: call.id,
        itemIds: call.item_ids,
        model: call.model,
        modelName: call.model_name,
        startedAt: call.started_at,
        firstTokenMs: call.first_token_ms,
        durationMs: call.duration_ms,
        inputTokens: call.input_tokens,
        outputTokens: call.output_tokens,
        cacheReadTokens: call.cache_read_tokens,
        cacheWriteTokens: call.cache_write_tokens,
        reasoning: call.reasoning,
      })
      .onConflictDoNothing()
      .run()
    this.#emit({ t: 'calls', rows: [call] })
  }

  /** Creates the row of the conversation, with its salt, if it is missing. */
  async ensure(conversationId: string) {
    if (this.#db.select({ id: conversation.id }).from(conversation).get()) return
    const idSalt = await this.#salt(conversationId)
    this.#db.insert(conversation).values({ id: conversationId, idSalt }).onConflictDoNothing().run()
  }

  async claim(conversationId: string, leaseMs: number): Promise<Claim> {
    await this.ensure(conversationId)
    const now = Date.now()
    const claimed = this.#db
      .update(conversation)
      .set({
        writerEpoch: sql`${conversation.writerEpoch} + 1`,
        leaseUntil: now + leaseMs,
        leaseMs,
      })
      .where(or(isNull(conversation.leaseUntil), lte(conversation.leaseUntil, now)))
      .returning({ epoch: conversation.writerEpoch })
      .get()
    if (claimed) return { epoch: claimed.epoch }
    const until = this.#db.select({ until: conversation.leaseUntil }).from(conversation).get()
    return { busyForMs: Math.max(1, (until?.until ?? now) - now) }
  }

  async renew(_conversationId: string, epoch: number) {
    this.#db.transaction((tx) => fence(tx, epoch))
  }

  async release(_conversationId: string, epoch: number) {
    this.#db
      .update(conversation)
      .set({ leaseUntil: null, leaseMs: null })
      .where(eq(conversation.writerEpoch, epoch))
      .run()
  }

  async load(conversationId: string, fromSeq: number) {
    await this.ensure(conversationId)
    const state = this.#db
      .select({
        salt: conversation.idSalt,
        head: conversation.headItemId,
        interrupt: conversation.interruptRequested,
      })
      .from(conversation)
      .get()
    const rows = this.#db
      .select({ ...itemColumns, blob: items.blob })
      .from(items)
      .where(gt(items.seq, fromSeq))
      .orderBy(asc(items.seq))
      .all()
    // A streaming item carries the text of its batches, joined back in the order of `idx`.
    const streaming = rows.filter((r) => r.status === 'streaming').map((r) => r.id)
    const live = new Map<string, string>()
    if (streaming.length > 0) {
      const chunks = this.#db
        .select({ itemId: itemChunks.itemId, text: itemChunks.text })
        .from(itemChunks)
        .where(inArray(itemChunks.itemId, streaming))
        .orderBy(asc(itemChunks.itemId), asc(itemChunks.idx))
        .all()
      for (const chunk of chunks)
        live.set(chunk.itemId, (live.get(chunk.itemId) ?? '') + chunk.text)
    }
    return {
      salt: state?.salt ?? '',
      head: state?.head ?? null,
      items: rows.map((row) => {
        const item = restoreItem(rowToItem(row), (row.blob as Part[] | null) ?? undefined)
        const text = live.get(row.id)
        return text !== undefined && (item.kind === 'assistant_text' || item.kind === 'reasoning')
          ? { ...item, text }
          : item
      }),
      interruptRequested: state?.interrupt ?? false,
    }
  }

  async append(conversationId: string, drafts: ItemDraft[], epoch: number) {
    const written = this.#db.transaction((tx) => {
      const writer = fence(tx, epoch)
      let seq = writer.lastSeq
      const persisted: { id: string; seq: number }[] = []
      const inserted: ItemShapeRow[] = []
      for (const draft of drafts) {
        const { payload, blob } = draftToRow(draft)
        const row = tx
          .insert(items)
          .values({
            id: draft.id,
            parentId: draft.parentId,
            seq: seq + 1,
            kind: draft.kind,
            payload,
            status: draft.status,
            blob: blob?.output ?? null,
          })
          .onConflictDoNothing({ target: items.id })
          .returning(itemColumns)
          .get()
        if (row) {
          seq = row.seq
          persisted.push({ id: draft.id, seq })
          inserted.push({ conversation_id: conversationId, ...row })
          continue
        }
        const existing = tx
          .select({ seq: items.seq })
          .from(items)
          .where(eq(items.id, draft.id))
          .get()
        persisted.push({ id: draft.id, seq: existing?.seq ?? 0 })
      }
      const head = drafts.at(-1)?.id
      tx.update(conversation)
        .set({ lastSeq: seq, ...(head ? { headItemId: head } : {}) })
        .run()
      return { persisted, inserted, head, interruptRequested: writer.interrupt }
    })
    if (written.inserted.length > 0) this.#emit({ t: 'items', rows: written.inserted })
    if (written.head) this.#emit({ t: 'head', head: written.head })
    return { persisted: written.persisted, interruptRequested: written.interruptRequested }
  }

  async appendBatch(
    conversationId: string,
    itemId: string,
    idx: number,
    text: string,
    epoch: number,
  ) {
    const written = this.#db.transaction((tx) => {
      const writer = fence(tx, epoch)
      const row = tx
        .insert(itemChunks)
        .values({ itemId, idx, text })
        .onConflictDoNothing()
        .returning({ idx: itemChunks.idx })
        .get()
      return { inserted: Boolean(row), interruptRequested: writer.interrupt }
    })
    if (written.inserted) {
      this.#emit({
        t: 'chunks',
        rows: [{ conversation_id: conversationId, item_id: itemId, idx, text }],
      })
    }
    return { interruptRequested: written.interruptRequested }
  }

  async settle(conversationId: string, final: ItemDraft, epoch: number) {
    const row = this.#db.transaction((tx) => {
      fence(tx, epoch)
      const { payload } = draftToRow(final)
      const updated = tx
        .update(items)
        .set({ payload, status: final.status })
        .where(eq(items.id, final.id))
        .returning(itemColumns)
        .get()
      if (!updated) throw new Error(`unknown item: ${final.id}`)
      tx.delete(itemChunks).where(eq(itemChunks.itemId, final.id)).run()
      return updated
    })
    // The final item first: the text stays on screen while its batches disappear.
    this.#emit({ t: 'items', rows: [{ conversation_id: conversationId, ...row }] })
    this.#emit({ t: 'chunks_cleared', itemId: final.id })
  }

  async setHead(_conversationId: string, itemId: string, epoch: number) {
    this.#db.transaction((tx) => {
      fence(tx, epoch)
      tx.update(conversation).set({ headItemId: itemId }).run()
    })
    this.#emit({ t: 'head', head: itemId })
  }

  async requestInterrupt(conversationId: string) {
    await this.ensure(conversationId)
    this.#db.update(conversation).set({ interruptRequested: true }).run()
  }

  async clearInterrupt(_conversationId: string, epoch: number) {
    this.#db.transaction((tx) => {
      fence(tx, epoch)
      tx.update(conversation).set({ interruptRequested: false }).run()
    })
  }

  async claimToolCall(_conversationId: string, callId: string, epoch: number) {
    return this.#db.transaction((tx) => {
      fence(tx, epoch)
      tx.insert(toolClaims).values({ callId, epoch }).onConflictDoNothing().run()
      const owner = tx
        .select({ epoch: toolClaims.epoch })
        .from(toolClaims)
        .where(eq(toolClaims.callId, callId))
        .get()
      return owner?.epoch === epoch ? ('claimed' as const) : ('already_claimed' as const)
    })
  }

  async loadSnapshot(_conversationId: string): Promise<Snapshot | undefined> {
    return this.#db.select({ data: snapshot.data }).from(snapshot).where(eq(snapshot.id, 1)).get()
      ?.data as Snapshot | undefined
  }

  async saveSnapshot(_conversationId: string, data: Snapshot, epoch: number) {
    this.#db.transaction((tx) => {
      fence(tx, epoch)
      tx.insert(snapshot)
        .values({ id: 1, data })
        .onConflictDoUpdate({ target: snapshot.id, set: { data } })
        .run()
    })
  }
}

type Ack = { ok: true } | { ok: false; error: string }

/**
 * Records the arrival of a command. Returns the acknowledgement already given to it, or `null`
 * while none was given: the command then runs, again if a previous run stopped before the end.
 */
export function recordCommand(db: DoDb, commandId: string, kind: string): Ack | null {
  const inserted = db
    .insert(commands)
    .values({ id: commandId, kind })
    .onConflictDoNothing()
    .returning({ id: commands.id })
    .get()
  if (inserted) return null
  const row = db
    .select({ ack: commands.ack })
    .from(commands)
    .where(eq(commands.id, commandId))
    .get()
  return (row?.ack as Ack | null | undefined) ?? null
}

export function saveAck(db: DoDb, commandId: string, ack: Ack) {
  db.update(commands).set({ ack }).where(eq(commands.id, commandId)).run()
}
