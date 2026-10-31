import type { Item, ItemDraft } from './journal.ts'

type Node = Item | ItemDraft

/** Path from the root to `head`: the displayed view of a conversation. */
export function pathTo<T extends Node>(items: readonly T[], head: string | null): T[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const path: T[] = []
  const seen = new Set<string>()
  for (let id = head; id !== null;) {
    const item = byId.get(id)
    if (!item || seen.has(id)) break
    seen.add(id)
    path.push(item)
    id = item.parentId
  }
  return path.reverse()
}

/** Violations of the journal invariants; an empty list means a valid journal. */
export function journalViolations(items: readonly Item[]): string[] {
  const out: string[] = []
  const byId = new Map<string, Item>()
  let lastSeq = -Infinity
  for (const item of items) {
    if (byId.has(item.id)) out.push(`duplicate identifier: ${item.id}`)
    byId.set(item.id, item)
    if (item.seq <= lastSeq) out.push(`seq not increasing: ${item.id}`)
    lastSeq = item.seq
  }
  const results = new Map<string, number>()
  for (const item of items) {
    if (item.parentId !== null) {
      const parent = byId.get(item.parentId)
      if (!parent) out.push(`parent absent : ${item.id}`)
      else if (parent.seq >= item.seq) out.push(`parent comes later: ${item.id}`)
    }
    if (item.kind === 'tool_result') {
      results.set(item.callId, (results.get(item.callId) ?? 0) + 1)
      const onPath = pathTo(items, item.id)
      if (!onPath.some((i) => i.kind === 'tool_call' && i.callId === item.callId)) {
        out.push(`result without a call on its path: ${item.id}`)
      }
    }
  }
  for (const [callId, n] of results) if (n > 1) out.push(`several results: ${callId}`)
  // A call without a result cannot be followed, on its path, by a new model response: an input
  // (message, result, external event) then a model output.
  for (const leaf of items) {
    const path = pathTo(items, leaf.id)
    if (path.length === 0 || path[path.length - 1]?.id !== leaf.id) continue
    const open = new Set<string>()
    let inputSinceOutput = false
    for (const i of path) {
      if (i.kind === 'assistant_text' || i.kind === 'reasoning' || i.kind === 'tool_call') {
        if (inputSinceOutput && open.size > 0) {
          out.push(`call without a result before a new model call: ${[...open].join(', ')}`)
          break
        }
        inputSinceOutput = false
        if (i.kind === 'tool_call') open.add(i.callId)
      } else if (i.kind === 'tool_result') {
        open.delete(i.callId)
        inputSinceOutput = true
      } else if (i.kind === 'user_message' || i.kind === 'external_event') {
        inputSinceOutput = true
      }
    }
  }
  return [...new Set(out)]
}
