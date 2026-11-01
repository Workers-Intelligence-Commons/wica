// View of a conversation for the screen: the synchronized rows become journal items again, the
// batches of a streaming item are assembled by `idx`, then `deriveView` from the Harness `client`
// package builds the view.

import { deriveView, type ConversationView } from '@wica/client'
import type { Item } from '@wica/core'

import { type ChunkRow, type ItemShapeRow, rowToItem } from '../shared/rows.ts'

/** Current text of each item, its batches in the order of their `idx`. */
export function liveText(chunks: readonly ChunkRow[]): Map<string, string> {
  const byItem = new Map<string, ChunkRow[]>()
  for (const chunk of chunks) {
    const list = byItem.get(chunk.item_id) ?? []
    list.push(chunk)
    byItem.set(chunk.item_id, list)
  }
  return new Map(
    [...byItem].map(([id, list]) => [
      id,
      list
        .sort((a, b) => a.idx - b.idx)
        .map((c) => c.text)
        .join(''),
    ]),
  )
}

export function conversationView(
  rows: readonly ItemShapeRow[],
  chunks: readonly ChunkRow[],
  head: string | null,
): ConversationView & { items: Item[] } {
  const items = rows.map(rowToItem)
  return { ...deriveView(items, head, liveText(chunks)), items }
}

/**
 * Versions of a message or a response: its siblings in the tree, in order, and its place among
 * them. A regenerated response is the child of a `regenerate` event placed next to the original
 * response: that event carries its version.
 */
export function branchesOf(items: readonly Item[], itemId: string) {
  const byId = new Map(items.map((i) => [i.id, i]))
  const item = byId.get(itemId)
  const above = item?.parentId ? byId.get(item.parentId) : undefined
  const node = above && isRegenerate(above) ? above : item
  const parent = node?.parentId ?? null
  const siblings = items
    .filter(
      (i) =>
        i.parentId === parent &&
        (i.kind === 'user_message' || i.kind === 'assistant_text' || isRegenerate(i)),
    )
    .sort((a, b) => a.seq - b.seq)
  return { siblings, index: siblings.findIndex((i) => i.id === node?.id) }
}

const isRegenerate = (item: Item) => item.kind === 'event' && item.name === 'regenerate'

/** Head to show after choosing another branch: the last leaf under this item. */
export function leafUnder(items: readonly Item[], itemId: string): string {
  const children = new Map<string, Item[]>()
  for (const item of items) {
    if (item.parentId === null) continue
    const list = children.get(item.parentId) ?? []
    list.push(item)
    children.set(item.parentId, list)
  }
  let current = itemId
  for (;;) {
    const next = (children.get(current) ?? []).sort((a, b) => b.seq - a.seq)[0]
    if (!next) return current
    current = next.id
  }
}
