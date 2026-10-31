// `Store` du Harness sur Postgres. Le jeton de clôture et le bail vivent dans
// `conversation_writers`, que la synchro ne voit pas ; chaque écriture vérifie l'`epoch` et
// prolonge le bail dans la même transaction, et y lit la demande d'interruption.

import type { ItemDraft, Part } from '@wica/core'
import { type Claim, type Snapshot, StaleEpochError, type Store } from '@wica/runtime'
import type postgres from 'postgres'

import { draftToRow, type ItemRow, restoreItem, rowToItem } from '../shared/rows.ts'

type Sql = postgres.Sql | postgres.TransactionSql

const randomSalt = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
}

/** Crée la conversation et son état d'écriture s'ils manquent. */
async function ensure(sql: Sql, conversationId: string) {
  await sql`
    INSERT INTO conversations (id, id_salt) VALUES (${conversationId}, ${randomSalt()})
    ON CONFLICT DO NOTHING`
  await sql`
    INSERT INTO conversation_writers (conversation_id) VALUES (${conversationId})
    ON CONFLICT DO NOTHING`
}

/**
 * Vérifie l'`epoch`, prolonge le bail et verrouille la ligne jusqu'à la fin de la transaction :
 * deux écritures de la même conversation s'y suivent, donc les `seq` ne se croisent pas.
 */
async function fence(sql: postgres.TransactionSql, conversationId: string, epoch: number) {
  const [row] = await sql<{ last_seq: number; interrupt: boolean }[]>`
    UPDATE conversation_writers
    SET lease_until = CASE WHEN lease_ms IS NULL THEN NULL
                           ELSE now() + lease_ms * interval '1 millisecond' END
    WHERE conversation_id = ${conversationId} AND writer_epoch = ${epoch}
    RETURNING last_seq, interrupt_requested_at IS NOT NULL AS interrupt`
  if (!row) throw new StaleEpochError(`epoch ${epoch} périmé pour ${conversationId}`)
  return row
}

export class PgStore implements Store {
  readonly #sql: postgres.Sql

  constructor(sql: postgres.Sql) {
    this.#sql = sql
  }

  async claim(conversationId: string, leaseMs: number): Promise<Claim> {
    return this.#sql.begin(async (sql) => {
      await ensure(sql, conversationId)
      const [claimed] = await sql<{ writer_epoch: number }[]>`
        UPDATE conversation_writers
        SET writer_epoch = writer_epoch + 1,
            lease_until = now() + ${leaseMs} * interval '1 millisecond',
            lease_ms = ${leaseMs}
        WHERE conversation_id = ${conversationId}
          AND (lease_until IS NULL OR lease_until <= now())
        RETURNING writer_epoch`
      if (claimed) return { epoch: claimed.writer_epoch }
      const [busy] = await sql<{ ms: number }[]>`
        SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM lease_until - now()) * 1000))::int AS ms
        FROM conversation_writers WHERE conversation_id = ${conversationId}`
      return { busyForMs: busy?.ms ?? 1 }
    })
  }

  async renew(conversationId: string, epoch: number) {
    await this.#sql.begin((sql) => fence(sql, conversationId, epoch))
  }

  async release(conversationId: string, epoch: number) {
    await this.#sql`
      UPDATE conversation_writers SET lease_until = NULL, lease_ms = NULL
      WHERE conversation_id = ${conversationId} AND writer_epoch = ${epoch}`
  }

  async load(conversationId: string, fromSeq: number) {
    await ensure(this.#sql, conversationId)
    const [conversation] = await this.#sql<
      { id_salt: string; head_item_id: string | null; interrupt: boolean }[]
    >`
      SELECT c.id_salt, c.head_item_id, w.interrupt_requested_at IS NOT NULL AS interrupt
      FROM conversations c JOIN conversation_writers w ON w.conversation_id = c.id
      WHERE c.id = ${conversationId}`
    // Un élément en flux porte le texte de ses lots, recollés dans l'ordre de `idx`.
    const rows = await this.#sql<(ItemRow & { blob: Part[] | null; live: string | null })[]>`
      SELECT i.id, i.parent_id, i.seq, i.status, i.payload, b.data AS blob,
             CASE WHEN i.status = 'streaming' THEN (
               SELECT string_agg(k.text, '' ORDER BY k.idx) FROM item_chunks k
               WHERE k.conversation_id = i.conversation_id AND k.item_id = i.id) END AS live
      FROM items i LEFT JOIN blobs b ON b.sha256 = i.blob_sha256
      WHERE i.conversation_id = ${conversationId} AND i.seq > ${fromSeq}::bigint
      ORDER BY i.seq`
    return {
      salt: conversation?.id_salt ?? '',
      head: conversation?.head_item_id ?? null,
      items: rows.map((row) => {
        const item = restoreItem(rowToItem(row), row.blob ?? undefined)
        return row.live !== null && (item.kind === 'assistant_text' || item.kind === 'reasoning')
          ? { ...item, text: row.live }
          : item
      }),
      interruptRequested: conversation?.interrupt ?? false,
    }
  }

  async append(conversationId: string, drafts: ItemDraft[], epoch: number) {
    return this.#sql.begin(async (sql) => {
      const writer = await fence(sql, conversationId, epoch)
      let seq = writer.last_seq
      const persisted: { id: string; seq: number }[] = []
      for (const draft of drafts) {
        const { payload, blob } = draftToRow(draft)
        if (blob) {
          await sql`
            INSERT INTO blobs (sha256, data) VALUES (${blob.sha256}, ${sql.json(blob.output)})
            ON CONFLICT DO NOTHING`
        }
        const [inserted] = await sql<{ seq: number }[]>`
          INSERT INTO items (conversation_id, id, parent_id, seq, kind, payload, status, blob_sha256)
          VALUES (${conversationId}, ${draft.id}, ${draft.parentId}, ${seq + 1}, ${draft.kind},
                  ${sql.json(payload as postgres.JSONValue)}, ${draft.status}, ${blob?.sha256 ?? null})
          ON CONFLICT (conversation_id, id) DO NOTHING
          RETURNING seq`
        if (inserted) {
          seq = inserted.seq
          persisted.push({ id: draft.id, seq })
          continue
        }
        const [existing] = await sql<{ seq: number }[]>`
          SELECT seq FROM items WHERE conversation_id = ${conversationId} AND id = ${draft.id}`
        persisted.push({ id: draft.id, seq: existing?.seq ?? 0 })
      }
      await sql`
        UPDATE conversation_writers SET last_seq = ${seq}
        WHERE conversation_id = ${conversationId}`
      const last = drafts.at(-1)
      if (last) {
        await sql`
          UPDATE conversations SET head_item_id = ${last.id}, updated_at = now()
          WHERE id = ${conversationId}`
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
    return this.#sql.begin(async (sql) => {
      const writer = await fence(sql, conversationId, epoch)
      await sql`
        INSERT INTO item_chunks (conversation_id, item_id, idx, text)
        VALUES (${conversationId}, ${itemId}, ${idx}, ${text})
        ON CONFLICT DO NOTHING`
      return { interruptRequested: writer.interrupt }
    })
  }

  async settle(conversationId: string, final: ItemDraft, epoch: number) {
    await this.#sql.begin(async (sql) => {
      await fence(sql, conversationId, epoch)
      const { payload } = draftToRow(final)
      const updated = await sql`
        UPDATE items SET payload = ${sql.json(payload as postgres.JSONValue)}, status = ${final.status}
        WHERE conversation_id = ${conversationId} AND id = ${final.id}`
      if (updated.count === 0) throw new Error(`élément inconnu : ${final.id}`)
      await sql`
        DELETE FROM item_chunks WHERE conversation_id = ${conversationId} AND item_id = ${final.id}`
    })
  }

  async setHead(conversationId: string, itemId: string, epoch: number) {
    await this.#sql.begin(async (sql) => {
      await fence(sql, conversationId, epoch)
      await sql`
        UPDATE conversations SET head_item_id = ${itemId}, updated_at = now()
        WHERE id = ${conversationId}`
    })
  }

  async requestInterrupt(conversationId: string) {
    await ensure(this.#sql, conversationId)
    await this.#sql`
      UPDATE conversation_writers SET interrupt_requested_at = now()
      WHERE conversation_id = ${conversationId}`
  }

  async clearInterrupt(conversationId: string, epoch: number) {
    await this.#sql.begin(async (sql) => {
      await fence(sql, conversationId, epoch)
      await sql`
        UPDATE conversation_writers SET interrupt_requested_at = NULL
        WHERE conversation_id = ${conversationId}`
    })
  }

  async claimToolCall(conversationId: string, callId: string, epoch: number) {
    return this.#sql.begin(async (sql) => {
      await fence(sql, conversationId, epoch)
      await sql`
        INSERT INTO tool_claims (conversation_id, call_id, epoch)
        VALUES (${conversationId}, ${callId}, ${epoch})
        ON CONFLICT DO NOTHING`
      const [owner] = await sql<{ epoch: number }[]>`
        SELECT epoch FROM tool_claims
        WHERE conversation_id = ${conversationId} AND call_id = ${callId}`
      return owner?.epoch === epoch ? ('claimed' as const) : ('already_claimed' as const)
    })
  }

  async loadSnapshot(conversationId: string): Promise<Snapshot | undefined> {
    const [row] = await this.#sql<{ data: Snapshot }[]>`
      SELECT data FROM snapshots WHERE conversation_id = ${conversationId}`
    return row?.data
  }

  async saveSnapshot(conversationId: string, snapshot: Snapshot, epoch: number) {
    await this.#sql.begin(async (sql) => {
      await fence(sql, conversationId, epoch)
      await sql`
        INSERT INTO snapshots (conversation_id, data)
        VALUES (${conversationId}, ${sql.json(snapshot as unknown as postgres.JSONValue)})
        ON CONFLICT (conversation_id) DO UPDATE SET data = EXCLUDED.data`
    })
  }
}
