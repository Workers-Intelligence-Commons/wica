// Server rendering rows, read through the data contracts for the account of the request: the
// page leaves with what defines the screen, then the browser sync takes over. For a
// conversation, only the last items of the displayed path are awaited.

import { pathTo } from '@wica/core'

import { rowToItem, type ShapeTable } from '../shared/rows.ts'
import { currentScope } from './context.ts'

/** Items of the displayed path sent with the page; the rest arrives through the sync. */
export const SSR_PATH_ITEMS = 30

export async function serverRows(
  table: ShapeTable,
  conversationId?: string,
): Promise<readonly unknown[]> {
  const { hub, req } = currentScope()
  const me = await hub.me(req)
  if (!me) return []
  if (table === 'conversations') return hub.index.list(me.id)
  if (!conversationId) return []
  const entry = await hub.index.get(conversationId)
  if (entry?.ownerId !== me.id) return []
  const journal = await hub.host.read(conversationId)
  const path = pathTo(journal.items.map(rowToItem), journal.head).slice(-SSR_PATH_ITEMS)
  const shown = new Set(path.map((i) => i.id))
  if (table === 'items') return journal.items.filter((r) => shown.has(r.id))
  if (table === 'model_calls')
    return journal.calls.filter((c) => c.item_ids.some((id) => shown.has(id)))
  const streaming = new Set(path.filter((i) => i.status === 'streaming').map((i) => i.id))
  return journal.chunks.filter((c) => streaming.has(c.item_id))
}
