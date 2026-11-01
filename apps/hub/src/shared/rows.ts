// Rows shared by the server and the browser, and the mapping between a journal item and its row
// in `items`.
// `payload` carries the item; `seq`, `status` and `parent_id` have their own columns, which are
// the source of truth.

import { canonicalJson, type Item, type ItemDraft, type Part, sha256 } from '@wica/core'

export type ItemRow = {
  conversation_id: string
  id: string
  parent_id: string | null
  seq: number
  kind: string
  payload: Record<string, unknown>
  status: Item['status']
  blob_sha256: string | null
}

export type ChunkRow = { conversation_id: string; item_id: string; idx: number; text: string }

/** An item as the sync carries it: without the reference to its large result. */
export type ItemShapeRow = Omit<ItemRow, 'blob_sha256'>

export type ConversationRow = {
  id: string
  owner_id: string
  organization_id: string | null
  parent_conversation_id: string | null
  parent_call_id: string | null
  title: string
  model: string | null
  head_item_id: string | null
  id_salt: string
  created_at: string
  updated_at: string
}

/** The synchronized tables, as the browser collections and server rendering name them. */
export type ShapeTable = 'conversations' | 'items' | 'item_chunks'

export const rowToItem = (row: Pick<ItemRow, 'id' | 'parent_id' | 'seq' | 'status' | 'payload'>) =>
  ({
    ...row.payload,
    id: row.id,
    parentId: row.parent_id,
    seq: row.seq,
    status: row.status,
  }) as Item

/**
 * Beyond this size, a tool result goes into `blobs`: the sync carries only its preview, and the
 * model reads the full content again through the `Store`.
 */
export const BLOB_THRESHOLD = 64 * 1024
const PREVIEW_CHARS = 2_000

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Row to write for an item, and the full content to set aside if it is too large. */
export function draftToRow(draft: ItemDraft): {
  payload: Record<string, unknown>
  blob: { sha256: string; output: Part[] } | null
} {
  const { seq: _seq, ...payload } = draft as ItemDraft & { seq?: number }
  if (draft.kind !== 'tool_result') return { payload, blob: null }
  const json = canonicalJson(draft.output)
  if (json.length <= BLOB_THRESHOLD) return { payload, blob: null }
  const digest = hex(sha256(new TextEncoder().encode(json)))
  const text = draft.output.map((p) => (p.type === 'text' ? p.text : `[${p.mediaType}]`)).join('\n')
  const preview: Part[] = [
    {
      type: 'text',
      text: `${text.slice(0, PREVIEW_CHARS)}\n[preview: ${json.length} bytes in total]`,
    },
  ]
  return {
    payload: { ...payload, output: preview },
    blob: { sha256: digest, output: draft.output },
  }
}

/** Full item: a preview takes back the content that was set aside. */
export const restoreItem = (item: Item, blob: Part[] | undefined): Item =>
  blob && item.kind === 'tool_result' ? { ...item, output: blob } : item
