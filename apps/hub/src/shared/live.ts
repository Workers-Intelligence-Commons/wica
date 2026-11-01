// Messages of a conversation's live socket on Workers, from its Durable Object to the browser:
// the rows of the journal as the sync collections hold them. The first message of each
// connection is a snapshot; the others are changes.

import type { ChunkRow, ItemShapeRow, ModelCallRow } from './rows.ts'

export type LiveFrame =
  /** Every row of the conversation, replacing what the browser held. */
  | {
      t: 'snapshot'
      head: string | null
      items: ItemShapeRow[]
      chunks: ChunkRow[]
      calls: ModelCallRow[]
    }
  /** Items written or changed, whole. */
  | { t: 'items'; rows: ItemShapeRow[] }
  /** Text batches of a streaming item. */
  | { t: 'chunks'; rows: ChunkRow[] }
  /** The batches of an item that settled, now in its final text. */
  | { t: 'chunks_cleared'; itemId: string }
  | { t: 'head'; head: string }
  /** Model calls that completed. */
  | { t: 'calls'; rows: ModelCallRow[] }

/** Path of the socket of a conversation. */
export const livePath = (conversationId: string) =>
  `/api/live/${encodeURIComponent(conversationId)}`
