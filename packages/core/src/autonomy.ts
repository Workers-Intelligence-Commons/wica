// Agents autonomes :
// réveils, garde-fous sans humain et reprise d'une ancienne branche. Tout se décide depuis le
// journal et l'heure reçue par l'événement : un tour sans état prend la même décision qu'un
// serveur qui garde l'état en mémoire.

import type { ItemDraft, Wakeup } from './journal.ts'
import { HARNESS_TOOLS, type ToolSpec } from './model.ts'
import { pathTo } from './tree.ts'

/** Garde-fous des réveils, réglés par l'hôte. */
export type WakeupPolicy = {
  /** Réveils déclenchés au plus par période ; au-delà, le suivant attend la fin de la période. */
  maxPerPeriod?: number
  /** Durée de la période du plafond. 24 h par défaut. */
  periodMs?: number
  /** Appels au modèle par réveil ; au-delà, la réponse au réveil s'arrête. */
  maxModelCalls?: number
  /** Durée d'une réponse à un réveil, comptée depuis le réveil. */
  maxDurationMs?: number
  /**
   * Réveils de suite sans rien de nouveau avant la pause automatique. 3 par défaut. La pause
   * dure jusqu'au prochain message d'une personne ou événement externe.
   */
  pauseAfterIdle?: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_PAUSE_AFTER_IDLE = 3

/**
 * Durée ISO 8601 en jours, heures, minutes et secondes (`P1D`, `PT15M`, `PT0.5S`), en
 * millisecondes. Un jour vaut 24 heures, sans calendrier ni heure d'été.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text)
  if (!match || text === 'P' || text.endsWith('T')) return undefined
  const [, d, h, m, s] = match
  const ms =
    ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60_000 + Number(s ?? 0) * 1000
  return ms > 0 ? ms : undefined
}

const eventData = <T>(items: readonly ItemDraft[], name: string): T[] =>
  items.flatMap((i) => (i.kind === 'event' && i.name === name ? [i.data as T] : []))

/** Réveils prévus et pas annulés, dans l'ordre où ils ont été prévus. */
export function scheduledWakeups(items: readonly ItemDraft[]): Wakeup[] {
  const cancelled = new Set(eventData<{ id: string }>(items, 'wakeup_cancelled').map((d) => d.id))
  return eventData<{ wakeup: Wakeup }>(items, 'wakeup_scheduled')
    .map((d) => d.wakeup)
    .filter((w) => !cancelled.has(w.id))
}

type Fired = { id: string; at: string }

/** Occurrence échue la plus récente d'un réveil, pas encore déclenchée. */
function dueOccurrence(wakeup: Wakeup, fired: Fired[], now: number): number | undefined {
  const start = Date.parse(wakeup.at)
  if (now < start) return undefined
  const last = Math.max(
    -Infinity,
    ...fired.filter((f) => f.id === wakeup.id).map((f) => Date.parse(f.at)),
  )
  const every = wakeup.every !== undefined ? parseDuration(wakeup.every) : undefined
  // Des occurrences manquées (machine endormie) ne déclenchent qu'un réveil, le plus récent.
  const occurrence = every ? start + Math.floor((now - start) / every) * every : start
  return occurrence > last ? occurrence : undefined
}

/** Prochaine occurrence d'un réveil après `now`. */
function nextOccurrence(wakeup: Wakeup, fired: Fired[], now: number): number | undefined {
  const start = Date.parse(wakeup.at)
  const every = wakeup.every !== undefined ? parseDuration(wakeup.every) : undefined
  if (!every) {
    return fired.some((f) => f.id === wakeup.id) || start <= now ? undefined : start
  }
  return now < start ? start : start + (Math.floor((now - start) / every) + 1) * every
}

/** Éléments produits par le modèle, par opposition aux entrées et aux ajouts du Harness. */
const fromModel = (i: ItemDraft) =>
  i.kind === 'assistant_text' ||
  i.kind === 'reasoning' ||
  (i.kind === 'tool_call' && !HARNESS_TOOLS.includes(i.tool))

const isTrigger = (i: ItemDraft) =>
  i.kind === 'user_message' ||
  i.kind === 'external_event' ||
  (i.kind === 'event' && i.name === 'wakeup_fired')

/**
 * Ce qu'une réponse à un réveil apporte : ce qu'elle montre ou demande à une personne et les
 * outils qui agissent. Deux réponses de même signature sans outil qui agit n'apportent rien.
 */
function novelty(segment: readonly ItemDraft[], tools: readonly ToolSpec[]) {
  let acts = false
  const shown: string[] = []
  for (const i of segment) {
    if (i.kind === 'assistant_text' && i.audience === 'user') shown.push(i.text)
    if (i.kind !== 'tool_call') continue
    if (i.channel === 'user') shown.push(JSON.stringify([i.tool, i.input]))
    else if (tools.find((t) => t.name === i.tool)?.annotations?.readOnlyHint !== true) acts = true
  }
  return { acts, shown: JSON.stringify(shown) }
}

/**
 * Pause automatique : les dernières réponses à des réveils, depuis le dernier message d'une
 * personne ou événement externe, n'ont rien apporté de nouveau (aucun outil qui agit, et ce
 * qu'elles montrent répète la réponse précédente).
 */
export function wakeupsPaused(
  path: readonly ItemDraft[],
  tools: readonly ToolSpec[],
  policy: WakeupPolicy = {},
): boolean {
  const limit = policy.pauseAfterIdle ?? DEFAULT_PAUSE_AFTER_IDLE
  const input = path.findLastIndex((i) => i.kind === 'user_message' || i.kind === 'external_event')
  const starts = path.flatMap((i, n) =>
    n > input && i.kind === 'event' && i.name === 'wakeup_fired' ? [n] : [],
  )
  if (starts.length < limit) return false
  const segments = starts.map((s, k) => novelty(path.slice(s + 1, starts[k + 1]), tools))
  // Chaque réponse est comparée à celle qui la précède ; la première à la dernière parole venue
  // d'avant les réveils, qu'on ne connaît pas : elle compte comme nouvelle.
  let idle = 0
  for (let k = segments.length - 1; k > 0 && idle < limit; k--) {
    const current = segments[k]
    const previous = segments[k - 1]
    if (!current || !previous || current.acts || current.shown !== previous.shown) break
    idle += 1
  }
  return idle >= limit
}

export type WakeupPlan = {
  /** Réveil à déclencher maintenant, avec son occurrence. */
  due?: { wakeup: Wakeup; occurrence: string }
  /** Heure à laquelle l'hôte doit réveiller la conversation pour la suite. */
  next?: string
}

/** Réveils à déclencher maintenant et prochaine heure de réveil, d'après le journal. */
export function planWakeups(
  items: readonly ItemDraft[],
  head: string | null,
  tools: readonly ToolSpec[],
  now: number,
  policy: WakeupPolicy = {},
): WakeupPlan {
  const wakeups = scheduledWakeups(items)
  if (wakeups.length === 0) return {}
  if (wakeupsPaused(pathTo(items, head), tools, policy)) return {}
  const fired = eventData<Fired>(items, 'wakeup_fired')
  const nexts = wakeups.flatMap((w) => {
    const n = nextOccurrence(w, fired, now)
    return n === undefined ? [] : [n]
  })
  const next = (extra: number[] = []) => {
    const at = Math.min(...nexts, ...extra)
    return Number.isFinite(at) ? new Date(at).toISOString() : undefined
  }
  const due = wakeups.flatMap((wakeup) => {
    const occurrence = dueOccurrence(wakeup, fired, now)
    return occurrence === undefined ? [] : [{ wakeup, occurrence }]
  })
  const first = due.sort((a, b) => a.occurrence - b.occurrence)[0]
  if (!first) return withNext(next())
  if (policy.maxPerPeriod !== undefined) {
    const period = policy.periodMs ?? DAY_MS
    const recent = fired.map((f) => Date.parse(f.at)).filter((t) => t > now - period)
    if (recent.length >= policy.maxPerPeriod) {
      // Plafond atteint : le réveil attend que le plus ancien de la période en sorte.
      return withNext(next([Math.min(...recent) + period]))
    }
  }
  return {
    due: { wakeup: first.wakeup, occurrence: new Date(first.occurrence).toISOString() },
    ...withNext(next()),
  }
}

const withNext = (next: string | undefined): WakeupPlan => (next ? { next } : {})

/**
 * Budget d'une réponse à un réveil dépassé : trop d'appels au modèle depuis le réveil, ou trop
 * de temps. Une réponse à une personne ou à un événement externe n'a pas ce budget.
 */
export function wakeupBudgetExceeded(
  path: readonly ItemDraft[],
  now: number,
  policy: WakeupPolicy = {},
): boolean {
  const start = path.findLastIndex(isTrigger)
  const trigger = path[start]
  if (!trigger || trigger.kind !== 'event') return false
  if (policy.maxDurationMs !== undefined && now - Date.parse(trigger.at) >= policy.maxDurationMs) {
    return true
  }
  if (policy.maxModelCalls === undefined) return false
  const after = path.slice(start + 1)
  const calls = after.filter((i, n) => fromModel(i) && !fromModel(after[n - 1] ?? trigger)).length
  return calls >= policy.maxModelCalls
}

/**
 * Appels qui ont agi sur l'environnement depuis une autre branche, et que le chemin affiché n'a
 * pas encore signalés : leur `callId` et l'ancêtre commun le plus proche. Les outils en lecture
 * seule et le canal utilisateur n'agissent pas.
 */
export function actedElsewhere(
  items: readonly ItemDraft[],
  head: string | null,
  tools: readonly ToolSpec[],
): { ancestor: string | null; callIds: string[] } | undefined {
  const path = pathTo(items, head)
  const onPath = new Map(path.map((i, n) => [i.id, n]))
  const reported = new Set(
    eventData<{ callIds?: string[] }>(path, 'branch_resumed').flatMap((d) => d.callIds ?? []),
  )
  const answered = new Set(items.flatMap((i) => (i.kind === 'tool_result' ? [i.callId] : [])))
  const byId = new Map(items.map((i) => [i.id, i]))
  const callIds: string[] = []
  let deepest = -1
  for (const item of items) {
    if (item.kind !== 'tool_call' || item.channel !== 'environment') continue
    if (onPath.has(item.id) || reported.has(item.callId) || !answered.has(item.callId)) continue
    if (tools.find((t) => t.name === item.tool)?.annotations?.readOnlyHint === true) continue
    callIds.push(item.callId)
    let cursor = item.parentId
    while (cursor !== null && !onPath.has(cursor)) cursor = byId.get(cursor)?.parentId ?? null
    if (cursor !== null) deepest = Math.max(deepest, onPath.get(cursor) ?? -1)
  }
  if (callIds.length === 0) return undefined
  return { ancestor: path[deepest]?.id ?? null, callIds }
}
