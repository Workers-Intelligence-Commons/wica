// Vue d'une conversation pour l'écran : les lignes synchronisées redeviennent des éléments du
// journal, les lots d'un élément en flux sont assemblés par `idx`, puis `deriveView` du paquet
// `client` du Harness construit la vue.

import { deriveView, type ConversationView } from '@wica/client'
import type { Item } from '@wica/core'

import { type ChunkRow, rowToItem } from '../shared/rows.ts'
import type { ItemShapeRow } from './collections.ts'

/** Texte en cours de chaque élément, ses lots dans l'ordre de leur `idx`. */
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
 * Versions d'un message ou d'une réponse : ses frères dans l'arbre, dans l'ordre, et sa place parmi
 * eux. Une réponse régénérée est l'enfant d'un événement `regenerate` posé à côté de la réponse
 * d'origine : c'est cet événement qui porte sa version.
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

/** Tête à afficher après le choix d'une autre branche : la dernière feuille sous cet élément. */
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
