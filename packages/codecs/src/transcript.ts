// Rendu du chemin actif commun à tous les formats d'API : ce que le modèle lit, dans l'ordre, sans la forme d'un fournisseur.
// Chaque codec traduit ces entrées dans son format et garde pour lui le tri des données opaques.

import { compactPath, HARNESS_TOOLS, type Item, type ModelRequest, type Part } from '@wica/core'

export type TranscriptEntry =
  /** Entrée lue comme une parole : une personne, un événement externe, un réveil. */
  | { type: 'user'; parts: Part[] }
  /** Consigne du Harness à sa place dans la conversation : résumé, reprise de branche. */
  | { type: 'developer'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text?: string; opaque?: { provider: string; data: unknown } }
  | { type: 'tool_call'; callId: string; tool: string; input: unknown }
  | { type: 'tool_result'; callId: string; tool: string; output: Part[]; isError: boolean }

/** Résultat d'outil minimal qui précède la parole de la personne (Paroles de la personne). */
export const USER_REPLY_ACK = 'Réponse de la personne reçue ; elle suit.'

/** Consigne d'une requête de résumé : ce dont la suite du travail a besoin, rien d'autre. */
export const SUMMARY_PROMPT =
  'Résume la conversation ci-dessus pour la suite du travail : demandes de la personne, faits établis, décisions prises, actions faites sur l’environnement et leurs résultats, questions ouvertes. Écris seulement le résumé, sans appeler d’outil.'

const text = (t: string): Part[] => [{ type: 'text', text: t }]

/** Les appels ajoutés par le Harness lui-même (approbations, questions d'outils) ne viennent pas du modèle. */
const fromHarness = (item: Item, own: Set<string>) =>
  (item.kind === 'tool_call' && item.channel === 'user' && HARNESS_TOOLS.includes(item.tool)) ||
  (item.kind === 'tool_result' && own.has(item.callId))

const externalEvent = (item: Extract<Item, { kind: 'external_event' }>): TranscriptEntry => ({
  type: 'user',
  parts: text(
    `Événement externe (source : ${item.source}, nom : ${item.name}, confiance : ${item.trust}) :\n${JSON.stringify(item.data)}`,
  ),
})

/**
 * Un réveil que l'agent s'est donné. Sa charge vient du modèle, parfois après une entrée non
 * fiable : elle arrive comme une entrée, jamais avec l'autorité des consignes.
 */
function wakeupFired(data: unknown): TranscriptEntry {
  const d = (data ?? {}) as { id?: string; at?: string; payload?: unknown }
  return {
    type: 'user',
    parts: text(
      `Réveil programmé (identifiant : ${d.id ?? '?'}, prévu pour ${d.at ?? '?'}) :\n${JSON.stringify(d.payload ?? null)}`,
    ),
  }
}

function branchResumed(data: unknown): TranscriptEntry {
  const calls = (data as { callIds?: string[] } | null)?.callIds ?? []
  return {
    type: 'developer',
    text: `La conversation reprend une branche plus ancienne. L'environnement a pu changer depuis${
      calls.length > 0 ? ` (appels faits sur une autre branche : ${calls.join(', ')})` : ''
    } : observe-le de nouveau avant d'agir sur ce que tu crois savoir.`,
  }
}

/** Chemin actif, compacté, vers les entrées que le modèle lit. */
export function toTranscript(request: ModelRequest): TranscriptEntry[] {
  const path = compactPath(request.path)
  const approvals = new Set(
    path.flatMap((i) =>
      i.kind === 'tool_call' && i.channel === 'user' && HARNESS_TOOLS.includes(i.tool)
        ? [i.callId]
        : [],
    ),
  )
  const out: TranscriptEntry[] = []
  const tools = new Map<string, string>()
  // Résultats d'outils en attente de rendu : ils sortent dans l'ordre des appels, puis les paroles
  // de la personne dans le même ordre, dès qu'un autre élément les suit.
  const callOrder: string[] = []
  let results: Extract<Item, { kind: 'tool_result' }>[] = []
  const flush = () => {
    if (results.length === 0) return
    const ordered = [...results].sort(
      (a, b) => callOrder.indexOf(a.callId) - callOrder.indexOf(b.callId),
    )
    for (const r of ordered) {
      out.push({
        type: 'tool_result',
        callId: r.callId,
        tool: tools.get(r.callId) ?? '',
        output: r.as === 'user' ? text(USER_REPLY_ACK) : r.output,
        isError: r.isError === true,
      })
    }
    for (const r of ordered) if (r.as === 'user') out.push({ type: 'user', parts: r.output })
    results = []
  }

  for (const item of path) {
    if (item.kind === 'summary') {
      flush()
      out.push({ type: 'developer', text: `Résumé de la conversation jusqu'ici :\n${item.text}` })
      continue
    }
    if (fromHarness(item, approvals)) continue
    if (item.kind === 'tool_result') {
      results.push(item)
      continue
    }
    if (item.kind === 'event') {
      if (item.name === 'branch_resumed') {
        flush()
        out.push(branchResumed(item.data))
      } else if (item.name === 'wakeup_fired') {
        flush()
        out.push(wakeupFired(item.data))
      }
      continue
    }
    flush()
    switch (item.kind) {
      case 'user_message':
        out.push({ type: 'user', parts: item.parts })
        break
      case 'external_event':
        out.push(externalEvent(item))
        break
      case 'assistant_text':
        if (item.text !== '') out.push({ type: 'assistant_text', text: item.text })
        break
      case 'reasoning':
        out.push({
          type: 'reasoning',
          ...(item.text !== undefined ? { text: item.text } : {}),
          ...(item.opaque ? { opaque: item.opaque } : {}),
        })
        break
      case 'tool_call':
        callOrder.push(item.callId)
        tools.set(item.callId, item.tool)
        out.push({ type: 'tool_call', callId: item.callId, tool: item.tool, input: item.input })
        break
    }
  }
  flush()
  if (request.summarize) out.push({ type: 'developer', text: SUMMARY_PROMPT })
  return out
}
