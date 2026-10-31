// Compaction: a `compacted` event replaces a range in the view of a path, without deleting
// anything from the journal. The compacted view, its size and the range to summarize are derived
// from the path alone.

import type { ItemDraft } from './journal.ts'

/** Compaction threshold set by the host. Absent: no compaction. */
export type CompactionPolicy = {
  /** Size of the model view, in characters, beyond which the past is summarized. */
  maxChars: number
}

export type Summary = { kind: 'summary'; text: string }

type Compacted = { from: string; to: string; summary: string }

const compacted = (i: ItemDraft): Compacted | undefined =>
  i.kind === 'event' && i.name === 'compacted' ? (i.data as Compacted) : undefined

/**
 * Replaces the summarized ranges with a `compacted` event of the path: `data.from` and `data.to`
 * bound the range, `data.summary` replaces it. Nothing is deleted from the journal.
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

/** Size, in characters, of what the model reads from a view: texts, tool inputs and outputs. */
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
 * Range to summarize before the model call, when the view exceeds the threshold: from the root up
 * to the item that precedes the current exchange (the last input and what follows it). No tool
 * call is separated from its result there, and an older summary goes into the new one. A range
 * already summarized is not summarized twice, even if the current exchange alone exceeds the
 * threshold.
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
