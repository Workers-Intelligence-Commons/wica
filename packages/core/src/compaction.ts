// Compaction (specs/harness.md, Le cœur et Journal de conversation) : un événement `compacted`
// remplace une plage dans la vue d'un chemin, sans rien supprimer du journal. La vue compactée,
// sa taille et la plage à résumer se déduisent du chemin seul.

import type { ItemDraft } from './journal.ts'

/** Seuil de compaction réglé par l'hôte. Absent : aucune compaction. */
export type CompactionPolicy = {
  /** Taille de la vue du modèle, en caractères, au-delà de laquelle le passé est résumé. */
  maxChars: number
}

export type Summary = { kind: 'summary'; text: string }

type Compacted = { from: string; to: string; summary: string }

const compacted = (i: ItemDraft): Compacted | undefined =>
  i.kind === 'event' && i.name === 'compacted' ? (i.data as Compacted) : undefined

/**
 * Remplace les plages résumées par un événement `compacted` du chemin : `data.from` et `data.to`
 * bornent la plage, `data.summary` la remplace. Rien n'est supprimé du journal.
 */
export function compactPath<T extends ItemDraft>(path: readonly T[]): (T | Summary)[] {
  const last = path.findLast((i) => compacted(i) !== undefined)
  const data = last && compacted(last)
  if (!last || !data) return [...path]
  const from = path.findIndex((i) => i.id === data.from)
  const to = path.findIndex((i) => i.id === data.to)
  if (from < 0 || to < from) return [...path]
  return [
    ...compactPath(path.slice(0, from)),
    { kind: 'summary', text: data.summary },
    ...path.slice(to + 1).filter((i) => i !== last),
  ]
}

/** Taille, en caractères, de ce que le modèle lit d'une vue : textes, entrées et sorties d'outils. */
export function visibleSize(view: readonly (ItemDraft | Summary)[]): number {
  let size = 0
  for (const i of view) {
    if (i.kind === 'summary' || i.kind === 'assistant_text') size += i.text.length
    else if (i.kind === 'reasoning') size += i.text?.length ?? 0
    else if (i.kind === 'user_message' || i.kind === 'tool_result') {
      const parts = i.kind === 'user_message' ? i.parts : i.output
      for (const p of parts) size += p.type === 'text' ? p.text.length : 0
    } else if (i.kind === 'tool_call') size += JSON.stringify(i.input ?? null).length
    else if (i.kind === 'external_event') size += JSON.stringify(i.data ?? null).length
  }
  return size
}

const isInput = (i: ItemDraft) =>
  i.kind === 'user_message' ||
  i.kind === 'external_event' ||
  (i.kind === 'event' && i.name === 'wakeup_fired')

/**
 * Plage à résumer avant l'appel au modèle, quand la vue dépasse le seuil : de la racine jusqu'à
 * l'élément qui précède l'échange en cours (la dernière entrée et sa suite). Aucun appel d'outil
 * n'y est séparé de son résultat, et un résumé plus ancien entre dans le nouveau. Une plage déjà
 * résumée ne l'est pas deux fois, même si l'échange en cours dépasse seul le seuil.
 */
export function compactionRange(
  path: readonly ItemDraft[],
  policy: CompactionPolicy | undefined,
): { from: string; to: string } | undefined {
  if (!policy || visibleSize(compactPath(path)) <= policy.maxChars) return undefined
  const start = path.findLastIndex(isInput)
  const from = path[0]
  const to = path[start - 1]
  if (start <= 0 || !from || !to) return undefined
  if (path.some((i) => compacted(i)?.to === to.id)) return undefined
  return { from: from.id, to: to.id }
}
