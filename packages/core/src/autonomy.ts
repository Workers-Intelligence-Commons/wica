// Autonomous agents: wake-ups, guardrails without a human, and resuming an old branch. Everything
// is decided from the journal and the time received with the event: a stateless turn makes the
// same decision as a server that keeps the state in memory.

import type { ItemDraft, Wakeup } from './journal.ts'
import { HARNESS_TOOLS, type ToolSpec } from './model.ts'
import { pathTo } from './tree.ts'

/** Wake-up guardrails, set by the host. */
export type WakeupPolicy = {
  /** Wake-ups fired at most per period; beyond that, the next one waits for the end of the period. */
  maxPerPeriod?: number
  /** Length of the cap period. 24 h by default. */
  periodMs?: number
  /** Model calls per wake-up; beyond that, the response to the wake-up stops. */
  maxModelCalls?: number
  /** Duration of a response to a wake-up, counted from the wake-up. */
  maxDurationMs?: number
  /**
   * Consecutive wake-ups with nothing new before the automatic pause. 3 by default. The pause
   * lasts until the next message from a person or external event.
   */
  pauseAfterIdle?: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_PAUSE_AFTER_IDLE = 3

/**
 * ISO 8601 duration in days, hours, minutes and seconds (`P1D`, `PT15M`, `PT0.5S`), in
 * milliseconds. A day is 24 hours, without calendar or daylight saving time.
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

/** Wake-ups scheduled and not cancelled, in the order in which they were scheduled. */
export function scheduledWakeups(items: readonly ItemDraft[]): Wakeup[] {
  const cancelled = new Set(eventData<{ id: string }>(items, 'wakeup_cancelled').map((d) => d.id))
  return eventData<{ wakeup: Wakeup }>(items, 'wakeup_scheduled')
    .map((d) => d.wakeup)
    .filter((w) => !cancelled.has(w.id))
}

type Fired = { id: string; at: string }

/** Most recent due occurrence of a wake-up, not yet fired. */
function dueOccurrence(wakeup: Wakeup, fired: Fired[], now: number): number | undefined {
  const start = Date.parse(wakeup.at)
  if (now < start) return undefined
  const last = Math.max(
    -Infinity,
    ...fired.filter((f) => f.id === wakeup.id).map((f) => Date.parse(f.at)),
  )
  const every = wakeup.every !== undefined ? parseDuration(wakeup.every) : undefined
  // Missed occurrences (machine asleep) fire only one wake-up, the most recent one.
  const occurrence = every ? start + Math.floor((now - start) / every) * every : start
  return occurrence > last ? occurrence : undefined
}

/** Next occurrence of a wake-up after `now`. */
function nextOccurrence(wakeup: Wakeup, fired: Fired[], now: number): number | undefined {
  const start = Date.parse(wakeup.at)
  const every = wakeup.every !== undefined ? parseDuration(wakeup.every) : undefined
  if (!every) {
    return fired.some((f) => f.id === wakeup.id) || start <= now ? undefined : start
  }
  return now < start ? start : start + (Math.floor((now - start) / every) + 1) * every
}

/** Items produced by the model, as opposed to inputs and to Harness additions. */
const fromModel = (i: ItemDraft) =>
  i.kind === 'assistant_text' ||
  i.kind === 'reasoning' ||
  (i.kind === 'tool_call' && !HARNESS_TOOLS.includes(i.tool))

const isTrigger = (i: ItemDraft) =>
  i.kind === 'user_message' ||
  i.kind === 'external_event' ||
  (i.kind === 'event' && i.name === 'wakeup_fired')

/**
 * What a response to a wake-up brings: what it shows or asks a person, and the tools that act.
 * Two responses with the same signature and no acting tool bring nothing.
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
 * Automatic pause: the last responses to wake-ups, since the last message from a person or
 * external event, brought nothing new (no acting tool, and what they show repeats the previous
 * response).
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
  // Each response is compared with the one before it; the first one with the last speech from
  // before the wake-ups, which is unknown: it counts as new.
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
  /** Wake-up to fire now, with its occurrence. */
  due?: { wakeup: Wakeup; occurrence: string }
  /** Time at which the host must wake the conversation for what follows. */
  next?: string
}

/** Wake-ups to fire now and next wake-up time, according to the journal. */
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
      // Cap reached: the wake-up waits until the oldest one of the period leaves it.
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
 * Budget of a response to a wake-up exceeded: too many model calls since the wake-up, or too much
 * time. A response to a person or to an external event has no such budget.
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
 * Calls that acted on the environment from another branch, and that the displayed path has not
 * reported yet: their `callId` and the closest common ancestor. Read-only tools and the user
 * channel do not act.
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
