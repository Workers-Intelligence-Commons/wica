import type { Item, ItemDraft } from './journal.ts'

type Node = Item | ItemDraft

/** Chemin de la racine jusqu'à `head` : la vue affichée d'une conversation. */
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

/** Violations des invariants du journal ; une liste vide veut dire un journal valide. */
export function journalViolations(items: readonly Item[]): string[] {
  const out: string[] = []
  const byId = new Map<string, Item>()
  let lastSeq = -Infinity
  for (const item of items) {
    if (byId.has(item.id)) out.push(`identifiant en double : ${item.id}`)
    byId.set(item.id, item)
    if (item.seq <= lastSeq) out.push(`seq non croissant : ${item.id}`)
    lastSeq = item.seq
  }
  const results = new Map<string, number>()
  for (const item of items) {
    if (item.parentId !== null) {
      const parent = byId.get(item.parentId)
      if (!parent) out.push(`parent absent : ${item.id}`)
      else if (parent.seq >= item.seq) out.push(`parent postérieur : ${item.id}`)
    }
    if (item.kind === 'tool_result') {
      results.set(item.callId, (results.get(item.callId) ?? 0) + 1)
      const onPath = pathTo(items, item.id)
      if (!onPath.some((i) => i.kind === 'tool_call' && i.callId === item.callId)) {
        out.push(`résultat sans appel sur son chemin : ${item.id}`)
      }
    }
  }
  for (const [callId, n] of results) if (n > 1) out.push(`plusieurs résultats : ${callId}`)
  // Un appel sans résultat ne peut être suivi, sur son chemin, d'une nouvelle réponse du modèle :
  // une entrée (message, résultat, événement externe) puis une sortie du modèle.
  for (const leaf of items) {
    const path = pathTo(items, leaf.id)
    if (path.length === 0 || path[path.length - 1]?.id !== leaf.id) continue
    const open = new Set<string>()
    let inputSinceOutput = false
    for (const i of path) {
      if (i.kind === 'assistant_text' || i.kind === 'reasoning' || i.kind === 'tool_call') {
        if (inputSinceOutput && open.size > 0) {
          out.push(`appel sans résultat avant un nouvel appel au modèle : ${[...open].join(', ')}`)
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
