// Lignes du rendu serveur, lues dans Postgres pour le compte de la requête : la page part avec
// ce qui définit l'écran, puis la synchro du navigateur prend le relais. Pour une conversation,
// seuls les derniers éléments du chemin affiché sont attendus.

import { pathTo } from '@wica/core'

import { rowToItem, type ItemRow } from '../shared/rows.ts'
import type { ShapeTable } from '../client/collections.ts'
import { currentScope } from './context.ts'

/** Éléments du chemin affiché envoyés avec la page ; le reste arrive par la synchro. */
export const SSR_PATH_ITEMS = 30

export async function serverRows(
  table: ShapeTable,
  conversationId?: string,
): Promise<readonly unknown[]> {
  const { chat, req } = currentScope()
  const me = await chat.me(req)
  if (!me) return []
  const sql = chat.sql
  if (table === 'conversations') {
    return sql`
      SELECT id, owner_id, organization_id, server_id, parent_conversation_id, parent_call_id,
             title, model, head_item_id, id_salt, created_at::text, updated_at::text
      FROM conversations WHERE owner_id = ${me.id} ORDER BY updated_at DESC`
  }
  if (table === 'servers') {
    return sql`
      SELECT id, owner_id, name, created_at::text, last_seen_at::text, revoked_at::text
      FROM servers WHERE owner_id = ${me.id}`
  }
  if (!conversationId) return []
  const [conversation] = await sql<{ head_item_id: string | null }[]>`
    SELECT head_item_id FROM conversations WHERE id = ${conversationId} AND owner_id = ${me.id}`
  if (!conversation) return []
  const rows = await sql<Omit<ItemRow, 'blob_sha256'>[]>`
    SELECT conversation_id, id, parent_id, seq, kind, payload, status
    FROM items WHERE conversation_id = ${conversationId} ORDER BY seq`
  const path = pathTo(rows.map(rowToItem), conversation.head_item_id).slice(-SSR_PATH_ITEMS)
  const shown = new Set(path.map((i) => i.id))
  if (table === 'items') return rows.filter((r) => shown.has(r.id))
  const streaming = path.filter((i) => i.status === 'streaming').map((i) => i.id)
  if (streaming.length === 0) return []
  return sql`
    SELECT conversation_id, item_id, idx, text FROM item_chunks
    WHERE conversation_id = ${conversationId} AND item_id = ANY(${streaming})`
}
