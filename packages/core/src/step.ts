// State machine of the core.

import {
  actedElsewhere,
  parseDuration,
  planWakeups,
  scheduledWakeups,
  wakeupBudgetExceeded,
  type WakeupPolicy,
} from './autonomy.ts'
import { type CompactionPolicy, compactionRange } from './compaction.ts'
import { canonicalJson, deterministicUuid, serverItemId, userMessageId } from './ids.ts'
import type {
  Destination,
  Item,
  ItemBody,
  ItemDraft,
  Origin,
  Part,
  Trust,
  Wakeup,
} from './journal.ts'
import {
  APPROVAL_TOOL,
  approvalCallId,
  ELICIT_TOOL,
  elicitCallId,
  type AssistantMessage,
  type Delta,
  type ModelRequest,
  type Question,
  type ToolCall,
  type ToolSpec,
} from './model.ts'
import { pathTo } from './tree.ts'

type EventBody =
  | { t: 'user_message'; parentId: string | null; parts: Part[]; from?: Origin }
  | { t: 'model_delta'; delta: Delta }
  | { t: 'model_done'; message: AssistantMessage }
  | { t: 'model_failed'; error: string }
  | { t: 'tool_result'; callId: string; output: Part[]; isError?: boolean; from?: Origin }
  | { t: 'tools_changed'; tools: ToolSpec[] }
  | { t: 'persisted'; items: { id: string; seq: number }[] }
  | { t: 'interrupt' }
  | { t: 'set_head'; itemId: string }
  /** `to`: the designated approver of the conversation, to whom the request is addressed. */
  | { t: 'approval_needed'; callId: string; question: string; to?: Destination }
  | { t: 'approval'; callId: string; granted: boolean; from?: Origin }
  | { t: 'external_event'; source: string; name: string; data: unknown; trust: Trust }
  /** The call of the `schedule` tool, allowed, schedules its wake-up. */
  | { t: 'wakeup_scheduled'; callId: string }
  /** The call of the `cancel_wakeup` tool, allowed, cancels a scheduled wake-up. */
  | { t: 'wakeup_cancelled'; callId: string }
  /** Summary returned by the model for a `summarize` request. */
  | { t: 'compacted'; from: string; to: string; summary: string }
  | { t: 'regenerate'; itemId: string; commandId: string }
  | { t: 'tool_question'; callId: string; n: number; input: unknown }
  /** The call, allowed, is delegated to the client that runs the tool. */
  | { t: 'tool_handed'; callId: string }
  | { t: 'resume' }

/** Each event carries the time provided by the host: the core never reads the clock. */
export type Event = EventBody & { at: string }

export type Intent =
  | { t: 'call_model'; request: ModelRequest }
  | { t: 'run_tool'; call: ToolCall }
  | { t: 'to_user'; item: ItemDraft }
  | { t: 'ask_user'; question: Question }
  | { t: 'persist'; items: ItemDraft[] }
  /** Wake the conversation at this time: scheduled wake-up, deadline of an approval. */
  | { t: 'schedule'; at: string }
  | { t: 'append_delta'; itemId: string; text: string }
  | { t: 'settle'; item: ItemDraft }

export type Policy = {
  /** `user_tool`: free text is a private thought; `direct`: it is shown (simple chat mode). */
  freeText: 'user_tool' | 'direct'
  /** Delay beyond which an unanswered approval counts as a refusal. Absent: no deadline. */
  approvalTimeoutMs?: number
  /** Wake-up guardrails. */
  wakeups?: WakeupPolicy
  /** Summary of the past when the model view becomes too large. Absent: no compaction. */
  compaction?: CompactionPolicy
}

type Stream = {
  trigger: string
  /** Last item produced by this response: parent of the next one. */
  tip: string | null
  nextRank: number
  /** Items open for streaming, in their order of creation. */
  open: { id: string; kind: 'assistant_text' | 'reasoning'; text: string }[]
}

export type State = {
  schema: 1
  conversationId: string
  salt: string
  items: Item[]
  /** Items emitted by `persist` and not yet acknowledged by the `Store`. */
  pending: ItemDraft[]
  maxSeq: number
  head: string | null
  tools: ToolSpec[]
  policy: Policy
  stream: Stream | null
}

export type Step = { state: State; intents: Intent[] }

/** Tool list of the last `tools_changed` snapshot of the displayed path. */
function toolsOnPath(items: (Item | ItemDraft)[], head: string | null): ToolSpec[] | undefined {
  const last = pathTo(items, head).findLast((i) => i.kind === 'event' && i.name === 'tools_changed')
  return last?.kind === 'event' ? (last.data as { tools: ToolSpec[] }).tools : undefined
}

export function initialState(init: {
  conversationId: string
  salt: string
  items?: Item[]
  head?: string | null
  policy?: Policy
}): State {
  const items = [...(init.items ?? [])].sort((a, b) => a.seq - b.seq)
  const head = init.head !== undefined ? init.head : (items[items.length - 1]?.id ?? null)
  return {
    schema: 1,
    conversationId: init.conversationId,
    salt: init.salt,
    items,
    pending: [],
    maxSeq: items.reduce((m, i) => Math.max(m, i.seq), 0),
    head,
    tools: [],
    policy: init.policy ?? { freeText: 'user_tool' },
    stream: null,
  }
}

const all = (s: State): (Item | ItemDraft)[] => [...s.items, ...s.pending]
const has = (s: State, id: string) => all(s).some((i) => i.id === id)

function draft(
  id: string,
  parentId: string | null,
  at: string,
  status: Item['status'],
  body: ItemBody,
  meta?: Item['meta'],
): ItemDraft {
  return { id, parentId, at, status, ...(meta ? { meta } : {}), ...body } as ItemDraft
}

/** Replaces an item (acknowledged or not) with its settled version. */
function replace(s: State, item: ItemDraft): State {
  const pending = s.pending.map((p) => (p.id === item.id ? item : p))
  const items = s.items.map((i) => (i.id === item.id ? { ...item, seq: i.seq } : i))
  return { ...s, pending, items }
}

function append(s: State, items: ItemDraft[], intents: Intent[], extra: Intent[] = []): Step {
  const fresh = items.filter((i) => !has(s, i.id))
  if (fresh.length === 0) return { state: s, intents: extra }
  const head = fresh[fresh.length - 1]?.id ?? s.head
  return {
    state: { ...s, pending: [...s.pending, ...fresh], head },
    intents: [...intents, { t: 'persist', items: fresh }, ...extra],
  }
}

function toolSpec(s: State, name: string): ToolSpec | undefined {
  return s.tools.find((t) => t.name === name)
}

/** Closes the items still open for streaming with a final status. */
function closeStream(s: State, status: Item['status']): Step {
  const streaming = all(s).filter((i) => i.status === 'streaming')
  // An interrupted response is the one the person saw being written: its text is addressed to them
  // as at the end of a response without a tool call, because a call exists only at the end of the message.
  const lastText =
    status === 'interrupted'
      ? streaming.findLast((i) => i.kind === 'assistant_text')?.id
      : undefined
  let state: State = { ...s, stream: null }
  const intents: Intent[] = []
  for (const item of streaming) {
    const open = s.stream?.open.find((o) => o.id === item.id)
    let settled = { ...item, status, ...(open ? { text: open.text } : {}) } as ItemDraft
    if (settled.kind === 'assistant_text' && status === 'interrupted') {
      const promoted = s.policy.freeText === 'user_tool' && settled.id === lastText
      if (s.policy.freeText === 'direct' || promoted) {
        settled = {
          ...settled,
          audience: 'user',
          ...(promoted ? { meta: { ...settled.meta, promoted: true } } : {}),
        }
      }
    }
    state = replace(state, settled)
    intents.push({ t: 'settle', item: settled })
  }
  return { state, intents }
}

function results(s: State): Map<string, Extract<ItemDraft, { kind: 'tool_result' }>> {
  return new Map(all(s).flatMap((i) => (i.kind === 'tool_result' ? [[i.callId, i] as const] : [])))
}

function unansweredCalls(s: State): ToolCall[] {
  return openCalls(all(s), s.head)
}

function openCalls(items: readonly ItemDraft[], head: string | null): ToolCall[] {
  const answered = new Set(items.flatMap((i) => (i.kind === 'tool_result' ? [i.callId] : [])))
  return pathTo(items, head).flatMap((i) =>
    i.kind === 'tool_call' && !answered.has(i.callId)
      ? [{ callId: i.callId, tool: i.tool, input: i.input, channel: i.channel }]
      : [],
  )
}

/** Last item of the path that counts for the resume, if it calls for a model response. */
function answerTrigger(path: readonly ItemDraft[]): ItemDraft | undefined {
  const last = path.findLast(
    (i) =>
      i.kind !== 'event' ||
      i.name === 'interrupted' ||
      i.name === 'regenerate' ||
      i.name === 'wakeup_fired',
  )
  const needsAnswer =
    last !== undefined &&
    (last.kind === 'user_message' ||
      last.kind === 'tool_result' ||
      last.kind === 'external_event' ||
      (last.kind === 'event' && (last.name === 'regenerate' || last.name === 'wakeup_fired')))
  return needsAnswer ? last : undefined
}

/**
 * The conversation is at rest according to its journal: no call of the path waits for its
 * result, and the last item does not call for a model response. The same rule decides whether a
 * resume has work; a client uses it to know that the server owes nothing more.
 */
export function settled(items: readonly ItemDraft[], head: string | null): boolean {
  return openCalls(items, head).length === 0 && !answerTrigger(pathTo(items, head))
}

function callItem(s: State, callId: string) {
  const item = all(s).find((i) => i.kind === 'tool_call' && i.callId === callId)
  return item?.kind === 'tool_call' ? item : undefined
}

/** The call has been delegated to its client: it now waits only for its result. */
const handed = (s: State, callId: string) =>
  all(s).some(
    (i) =>
      i.kind === 'event' &&
      i.name === 'handed' &&
      (i.data as { callId?: string }).callId === callId,
  )

function resume(s: State, at: string): Step {
  // A turn starts only after a successful claim: a stream still open comes from a lost turn.
  const closed = closeStream(s, 'interrupted')
  const state = closed.state
  const intents = [...closed.intents]

  const calls = unansweredCalls(state)
  if (calls.length > 0) {
    const answered = results(state)
    for (const call of calls) {
      // A user channel tool runs on the client unless it declares itself run by the server
      // (`say`). An environment tool run by a client (files of an editor) first goes through
      // authorization, like any tool: `run_tool`, which the server does not run itself.
      const runsOn = toolSpec(state, call.tool)?.runsOn
      if (
        (call.channel === 'user' && runsOn !== 'server') ||
        (runsOn === 'client' && handed(state, call.callId))
      ) {
        intents.push({ t: 'ask_user', question: call })
        continue
      }
      const approval = callItem(state, approvalCallId(call.callId))
      if (!approval) {
        intents.push({ t: 'run_tool', call })
        continue
      }
      const answer = answered.get(approval.callId)
      if (!answer) {
        // The person has not answered yet: nothing leaves, except at the deadline, which counts as a refusal.
        const timeout = state.policy.approvalTimeoutMs
        if (timeout === undefined) continue
        const deadline = Date.parse(approval.at) + timeout
        if (deadline > Date.parse(at)) {
          intents.push({ t: 'schedule', at: new Date(deadline).toISOString() })
          continue
        }
        const out = append(
          state,
          [approvalResult(state, approval, false, at, { expired: true })],
          intents,
        )
        const next = resume(out.state, at)
        return { state: next.state, intents: [...out.intents, ...next.intents] }
      }
      if (answer.meta?.granted === true) {
        intents.push({ t: 'run_tool', call: { ...call, approved: true } })
        continue
      }
      // Refusal: the call receives its result, then the resume continues on the completed journal.
      const item = draft(
        resultId(state, callItem(state, call.callId)?.id ?? null, call.callId),
        state.head,
        at,
        'done',
        {
          kind: 'tool_result',
          callId: call.callId,
          output: [{ type: 'text', text: 'Refused by the person.' }],
          isError: true,
        },
      )
      const out = append(state, [item], intents)
      const next = resume(out.state, at)
      return { state: next.state, intents: [...out.intents, ...next.intents] }
    }
    return { state, intents }
  }

  const path = pathTo(all(state), state.head)
  const last = answerTrigger(path)
  if (!last) return idle(state, at, intents)
  if (wakeupBudgetExceeded(path, Date.parse(at), state.policy.wakeups)) {
    // Wake-up budget exhausted: the response stops like an interruption, recorded in the journal.
    const item = draft(
      serverItemId({
        conversationId: state.conversationId,
        parentId: state.head,
        trigger: `budget:${last.id}`,
        rank: 0,
      }),
      state.head,
      at,
      'done',
      { kind: 'event', name: 'interrupted', data: { reason: 'wakeup_budget' } },
    )
    return append(state, [item], intents)
  }

  // The environment acted on another branch: the model is invited to observe again.
  let current = state
  const elsewhere = actedElsewhere(all(current), current.head, current.tools)
  if (elsewhere) {
    const id = serverItemId({
      conversationId: state.conversationId,
      parentId: current.head,
      trigger: `branch_resumed:${elsewhere.callIds.join(',')}`,
      rank: 0,
    })
    const item = draft(id, current.head, at, 'done', {
      kind: 'event',
      name: 'branch_resumed',
      data: elsewhere,
    })
    const out = append(current, [item], [])
    current = out.state
    intents.push(...out.intents)
  }

  // One tool snapshot per model call, decided from the journal alone: a turn that rebuilds its
  // state makes the same decision as a server that keeps it in memory.
  const snapshot = toolsOnPath(all(current), current.head)
  if (snapshot === undefined || canonicalJson(snapshot) !== canonicalJson(current.tools)) {
    const id = serverItemId({
      conversationId: current.conversationId,
      parentId: current.head,
      trigger: `tools:${deterministicUuid(current.tools)}`,
      rank: 0,
    })
    const item = draft(id, current.head, at, 'done', {
      kind: 'event',
      name: 'tools_changed',
      data: { tools: current.tools },
    })
    const out = append(current, [item], [])
    current = out.state
    intents.push(...out.intents)
  }

  // View too large: the past is summarized first; the model call follows at the resume.
  const currentPath = pathTo(all(current), current.head)
  const range = compactionRange(currentPath, current.policy.compaction)
  if (range) {
    const end = currentPath.findIndex((i) => i.id === range.to)
    return {
      state: current,
      intents: [
        ...intents,
        {
          t: 'call_model',
          request: {
            trigger: `compact:${range.to}`,
            path: currentPath.slice(0, end + 1) as Item[],
            tools: [],
            summarize: range,
          },
        },
      ],
    }
  }

  return {
    state: { ...current, stream: { trigger: last.id, tip: current.head, nextRank: 0, open: [] } },
    intents: [
      ...intents,
      {
        t: 'call_model',
        request: {
          trigger: last.id,
          path: pathTo(all(current), current.head) as Item[],
          tools: current.tools,
        },
      },
    ],
  }
}

/**
 * Conversation at rest: the oldest due wake-up fires, and the time of the next one goes to the
 * host. A wake-up never cuts off work in progress.
 */
function idle(s: State, at: string, intents: Intent[]): Step {
  const plan = planWakeups(all(s), s.head, s.tools, Date.parse(at), s.policy.wakeups)
  const later: Intent[] = plan.next ? [{ t: 'schedule', at: plan.next }] : []
  if (!plan.due) return { state: s, intents: [...intents, ...later] }
  const { wakeup, occurrence } = plan.due
  // The identifier depends only on the wake-up and its occurrence: a wake-up delivered twice
  // fires only once, whatever the head.
  const id = serverItemId({
    conversationId: s.conversationId,
    parentId: null,
    trigger: `wakeup:${wakeup.id}:${occurrence}`,
    rank: 0,
  })
  const item = draft(id, s.head, at, 'done', {
    kind: 'event',
    name: 'wakeup_fired',
    data: { id: wakeup.id, at: occurrence, payload: wakeup.payload },
  })
  const out = append(s, [item], intents)
  const next = resume(out.state, at)
  return { state: next.state, intents: [...out.intents, ...next.intents] }
}

/** Answer to an approval request: granted, refused, or refused at the deadline. */
function approvalResult(
  s: State,
  request: Extract<ItemDraft, { kind: 'tool_call' }>,
  granted: boolean,
  at: string,
  o: { from?: Origin; expired?: boolean } = {},
): ItemDraft {
  return draft(
    resultId(s, request.id, request.callId),
    s.head,
    at,
    'done',
    {
      kind: 'tool_result',
      callId: request.callId,
      output: [
        {
          type: 'text',
          text: granted ? 'Granted.' : o.expired ? 'Refused: timed out.' : 'Refused.',
        },
      ],
      as: 'user',
      ...(o.from ? { from: o.from } : {}),
    },
    { granted, ...(o.expired ? { expired: true } : {}) },
  )
}

/** Input of the `schedule` tool to a wake-up, or the reason it is refused. */
function wakeupFrom(callId: string, input: unknown, at: string): Wakeup | string {
  const i = (input ?? {}) as {
    at?: unknown
    inSeconds?: unknown
    every?: unknown
    payload?: unknown
  }
  if ((i.at === undefined) === (i.inSeconds === undefined)) {
    return 'Give either at (ISO 8601 date) or inSeconds (delay in seconds).'
  }
  let when: number
  if (i.at !== undefined) {
    when = typeof i.at === 'string' ? Date.parse(i.at) : Number.NaN
    if (Number.isNaN(when)) return `Invalid date: ${JSON.stringify(i.at)}.`
  } else {
    if (typeof i.inSeconds !== 'number' || !(i.inSeconds >= 0)) {
      return 'inSeconds must be a positive number.'
    }
    when = Date.parse(at) + i.inSeconds * 1000
  }
  if (i.every !== undefined && (typeof i.every !== 'string' || !parseDuration(i.every))) {
    return 'every must be an ISO 8601 duration in days, hours, minutes or seconds (PT15M, P1D).'
  }
  return {
    id: callId,
    at: new Date(when).toISOString(),
    ...(typeof i.every === 'string' ? { every: i.every } : {}),
    payload: i.payload ?? null,
  }
}

function nextId(s: State, stream: Stream): string {
  return serverItemId({
    conversationId: s.conversationId,
    parentId: stream.tip,
    trigger: stream.trigger,
    rank: stream.nextRank,
  })
}

function modelDelta(s: State, delta: Delta, at: string): Step {
  const stream = s.stream
  if (!stream) return { state: s, intents: [] }
  const kind = delta.type === 'text' ? 'assistant_text' : 'reasoning'
  const current = stream.open[stream.open.length - 1]
  if (current && current.kind === kind) {
    const open = stream.open.map((o) => (o === current ? { ...o, text: o.text + delta.text } : o))
    return {
      state: { ...s, stream: { ...stream, open } },
      intents: [{ t: 'append_delta', itemId: current.id, text: delta.text }],
    }
  }
  const id = nextId(s, stream)
  const body: ItemBody =
    kind === 'assistant_text'
      ? { kind, text: '', audience: 'private' }
      : { kind: 'reasoning', text: '' }
  const item = draft(id, stream.tip, at, 'streaming', body)
  const next: Stream = {
    ...stream,
    tip: id,
    nextRank: stream.nextRank + 1,
    open: [...stream.open, { id, kind, text: delta.text }],
  }
  return append(
    { ...s, stream: next },
    [item],
    [],
    [{ t: 'append_delta', itemId: id, text: delta.text }],
  )
}

function modelDone(s: State, message: AssistantMessage, at: string): Step {
  const stream = s.stream
  if (!stream) return { state: s, intents: [] }
  const hasCalls = message.parts.some((p) => p.type === 'tool_call')
  const lastText = message.parts.findLastIndex((p) => p.type === 'text')
  const open = [...stream.open]
  let state: State = s
  let tip = stream.tip
  let rank = stream.nextRank
  const settles: Intent[] = []
  const fresh: ItemDraft[] = []

  message.parts.forEach((part, index) => {
    let body: ItemBody
    let meta: Item['meta'] | undefined
    if (part.type === 'text') {
      const promoted = s.policy.freeText === 'user_tool' && !hasCalls && index === lastText
      const audience = s.policy.freeText === 'direct' || promoted ? 'user' : 'private'
      body = { kind: 'assistant_text', text: part.text, audience }
      if (promoted) meta = { promoted: true }
    } else if (part.type === 'reasoning') {
      body = {
        kind: 'reasoning',
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.opaque ? { opaque: part.opaque } : {}),
      }
    } else {
      const spec = toolSpec(s, part.tool)
      body = {
        kind: 'tool_call',
        callId: part.callId,
        tool: part.tool,
        input: part.input,
        channel: spec?.channel ?? 'environment',
      }
    }
    const streamedIndex = open.findIndex((o) => o.kind === body.kind)
    const streamed = streamedIndex >= 0 ? open.splice(streamedIndex, 1)[0] : undefined
    const existing = streamed && all(state).find((i) => i.id === streamed.id)
    if (existing) {
      const settled = {
        ...existing,
        ...body,
        status: 'done',
        ...(meta ? { meta } : {}),
      } as ItemDraft
      state = replace(state, settled)
      settles.push({ t: 'settle', item: settled })
      return
    }
    const id = serverItemId({
      conversationId: s.conversationId,
      parentId: tip,
      trigger: stream.trigger,
      rank,
    })
    fresh.push(draft(id, tip, at, 'done', body, meta))
    tip = id
    rank += 1
  })

  // An open item without a matching part keeps the text received.
  for (const leftover of open) {
    const existing = all(state).find((i) => i.id === leftover.id)
    if (!existing) continue
    const settled = { ...existing, text: leftover.text, status: 'done' } as ItemDraft
    state = replace(state, settled)
    settles.push({ t: 'settle', item: settled })
  }

  state = { ...state, stream: null, head: tip }
  return fresh.length === 0 ? { state, intents: settles } : append(state, fresh, settles)
}

/** A call has only one result: real or synthetic, it carries the same identifier. */
function resultId(s: State, callItemId: string | null, callId: string): string {
  return serverItemId({
    conversationId: s.conversationId,
    parentId: callItemId,
    trigger: `result:${callId}`,
    rank: 0,
  })
}

function toolResult(s: State, e: Extract<EventBody, { t: 'tool_result' }>, at: string): Step {
  const call = all(s).find((i) => i.kind === 'tool_call' && i.callId === e.callId)
  if (!call || call.kind !== 'tool_call') return { state: s, intents: [] }
  const spec = toolSpec(s, call.tool)
  // Only the channel tools registered by the host, and the answer to a question asked by a tool
  // (MCP information request), speak with the authority of the person.
  const asUser =
    call.channel === 'user' &&
    (call.tool === ELICIT_TOOL || (spec?.channel === 'user' && spec.speaker === 'user'))
  // A result coming from the open world (web, mail) does not count as an instruction from the owner.
  const untrusted = call.channel === 'environment' && spec?.annotations?.openWorldHint === true
  const item = draft(
    resultId(s, call.id, e.callId),
    s.head,
    at,
    'done',
    {
      kind: 'tool_result',
      callId: e.callId,
      output: e.output,
      ...(e.isError ? { isError: true } : {}),
      ...(asUser ? { as: 'user' as const } : {}),
      ...(e.from ? { from: e.from } : {}),
    },
    untrusted ? { untrusted: true } : undefined,
  )
  // The questions of this call that are still open become moot when it has its result.
  const answered = results(s)
  const stale = all(s).flatMap((i) =>
    i.kind === 'tool_call' &&
    i.tool === ELICIT_TOOL &&
    i.callId.startsWith(`elicit:${e.callId}:`) &&
    !answered.has(i.callId)
      ? [i]
      : [],
  )
  let parent = item.id
  const closing = stale.map((q) => {
    const r = draft(resultId(s, q.id, q.callId), parent, at, 'done', {
      kind: 'tool_result',
      callId: q.callId,
      output: [{ type: 'text', text: 'Question no longer relevant.' }],
      isError: true,
    })
    parent = r.id
    return r
  })
  return append(s, [item, ...closing], [])
}

function interrupt(s: State, at: string): Step {
  const closed = closeStream(s, 'interrupted')
  let state = closed.state
  const intents = [...closed.intents]
  const results: ItemDraft[] = []
  let parent = state.head
  for (const call of unansweredCalls(state)) {
    const callItem = all(state).find((i) => i.kind === 'tool_call' && i.callId === call.callId)
    const id = resultId(s, callItem?.id ?? null, call.callId)
    results.push(
      draft(id, parent, at, 'done', {
        kind: 'tool_result',
        callId: call.callId,
        output: [{ type: 'text', text: 'Interrupted by the person.' }],
        isError: true,
      }),
    )
    parent = id
  }
  const marker = draft(
    serverItemId({
      conversationId: s.conversationId,
      parentId: parent,
      trigger: `interrupt:${at}`,
      rank: 0,
    }),
    parent,
    at,
    'done',
    { kind: 'event', name: 'interrupted', data: null },
  )
  const out = append(state, [...results, marker], intents)
  state = out.state
  return { state, intents: out.intents }
}

/** Call of `schedule` or `cancel_wakeup`: the journal event, then the result. */
function wakeupCall(
  s: State,
  e: Extract<Event, { t: 'wakeup_scheduled' } | { t: 'wakeup_cancelled' }>,
): Step {
  const call = callItem(s, e.callId)
  if (!call || results(s).has(e.callId)) return { state: s, intents: [] }
  const result = (text: string, isError = false) =>
    draft(resultId(s, call.id, e.callId), call.id, e.at, 'done', {
      kind: 'tool_result',
      callId: e.callId,
      output: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {}),
    })
  const event = (name: 'wakeup_scheduled' | 'wakeup_cancelled', data: unknown) =>
    draft(
      serverItemId({
        conversationId: s.conversationId,
        parentId: call.id,
        trigger: `${name}:${e.callId}`,
        rank: 0,
      }),
      s.head,
      e.at,
      'done',
      { kind: 'event', name, data },
    )
  const chain = (items: ItemDraft[]) =>
    items.map((item, n) => ({ ...item, parentId: n === 0 ? s.head : (items[n - 1]?.id ?? null) }))
  if (e.t === 'wakeup_scheduled') {
    const wakeup = wakeupFrom(e.callId, call.input, e.at)
    if (typeof wakeup === 'string')
      return append(s, [{ ...result(wakeup, true), parentId: s.head }], [])
    const text = `Wake-up ${wakeup.id} scheduled for ${wakeup.at}${wakeup.every ? `, then every ${wakeup.every}` : ''}.`
    return append(
      s,
      chain([event('wakeup_scheduled', { wakeup }), result(text)]),
      [],
      [{ t: 'schedule', at: wakeup.at }],
    )
  }
  const id = (call.input as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !scheduledWakeups(all(s)).some((w) => w.id === id)) {
    return append(
      s,
      [
        {
          ...result(`No scheduled wake-up has the identifier ${String(id)}.`, true),
          parentId: s.head,
        },
      ],
      [],
    )
  }
  return append(
    s,
    chain([event('wakeup_cancelled', { id }), result(`Wake-up ${id} cancelled.`)]),
    [],
  )
}

export function step(state: State, event: Event): Step {
  switch (event.t) {
    case 'user_message': {
      const id = userMessageId({
        salt: state.salt,
        conversationId: state.conversationId,
        parentId: event.parentId,
        from: event.from ?? { channel: 'default' },
        parts: event.parts,
      })
      const item = draft(id, event.parentId, event.at, 'done', {
        kind: 'user_message',
        parts: event.parts,
        ...(event.from ? { from: event.from } : {}),
      })
      if (has(state, id)) return { state: { ...state, head: id }, intents: [] }
      return append(state, [item], [])
    }
    case 'model_delta':
      return modelDelta(state, event.delta, event.at)
    case 'model_done':
      return modelDone(state, event.message, event.at)
    case 'model_failed':
      // The text already received stays, marked as failed; nothing restarts the model in this turn.
      return closeStream(state, 'failed')
    case 'tool_result':
      return toolResult(state, event, event.at)
    case 'tools_changed':
      // The host declares the configured tools; the snapshot is written by `resume`, before the model call.
      return { state: { ...state, tools: event.tools }, intents: [] }
    case 'persisted': {
      const seqs = new Map(event.items.map((i) => [i.id, i.seq]))
      const done = state.pending.filter((p) => seqs.has(p.id))
      const items = [
        ...state.items,
        ...done.map((p) => ({ ...p, seq: seqs.get(p.id) as number }) as Item),
      ]
      return {
        state: {
          ...state,
          items,
          pending: state.pending.filter((p) => !seqs.has(p.id)),
          maxSeq: Math.max(state.maxSeq, ...event.items.map((i) => i.seq)),
        },
        intents: [],
      }
    }
    case 'interrupt':
      return interrupt(state, event.at)
    case 'set_head':
      return has(state, event.itemId)
        ? { state: { ...state, head: event.itemId }, intents: [] }
        : { state, intents: [] }
    case 'tool_handed': {
      const call = callItem(state, event.callId)
      if (!call || handed(state, event.callId)) return { state, intents: [] }
      const id = serverItemId({
        conversationId: state.conversationId,
        parentId: call.id,
        trigger: `handed:${event.callId}`,
        rank: 0,
      })
      const item = draft(id, state.head, event.at, 'done', {
        kind: 'event',
        name: 'handed',
        data: { callId: event.callId },
      })
      return append(state, [item], [])
    }
    case 'approval_needed': {
      const call = callItem(state, event.callId)
      if (!call) return { state, intents: [] }
      const callId = approvalCallId(event.callId)
      const id = serverItemId({
        conversationId: state.conversationId,
        parentId: call.id,
        trigger: callId,
        rank: 0,
      })
      const item = draft(id, state.head, event.at, 'done', {
        kind: 'tool_call',
        callId,
        tool: APPROVAL_TOOL,
        input: { callId: event.callId, question: event.question },
        channel: 'user',
        ...(event.to ? { to: event.to } : {}),
      })
      return append(state, [item], [])
    }
    case 'approval': {
      const request = callItem(state, approvalCallId(event.callId))
      if (!request) return { state, intents: [] }
      const item = approvalResult(
        state,
        request,
        event.granted,
        event.at,
        event.from ? { from: event.from } : {},
      )
      return append(state, [item], [])
    }
    case 'external_event': {
      const { source, name, data, trust } = event
      // A repeated delivery of the same event under the same parent forms only one item.
      const id = serverItemId({
        conversationId: state.conversationId,
        parentId: state.head,
        trigger: `external:${deterministicUuid({ source, name, data, trust })}`,
        rank: 0,
      })
      const item = draft(id, state.head, event.at, 'done', {
        kind: 'external_event',
        source,
        name,
        data,
        trust,
      })
      if (has(state, id)) return { state, intents: [] }
      return append(state, [item], [])
    }
    case 'wakeup_scheduled':
    case 'wakeup_cancelled':
      return wakeupCall(state, event)
    case 'compacted': {
      const id = serverItemId({
        conversationId: state.conversationId,
        parentId: state.head,
        trigger: `compacted:${event.to}`,
        rank: 0,
      })
      const item = draft(id, state.head, event.at, 'done', {
        kind: 'event',
        name: 'compacted',
        data: { from: event.from, to: event.to, summary: event.summary },
      })
      return append(state, [item], [])
    }
    case 'tool_question': {
      const call = callItem(state, event.callId)
      if (!call) return { state, intents: [] }
      const callId = elicitCallId(event.callId, event.n)
      const item = draft(
        serverItemId({
          conversationId: state.conversationId,
          parentId: call.id,
          trigger: callId,
          rank: 0,
        }),
        state.head,
        event.at,
        'done',
        { kind: 'tool_call', callId, tool: ELICIT_TOOL, input: event.input, channel: 'user' },
      )
      return append(state, [item], [])
    }
    case 'regenerate': {
      if (!has(state, event.itemId)) return { state, intents: [] }
      const id = serverItemId({
        conversationId: state.conversationId,
        parentId: event.itemId,
        trigger: `regenerate:${event.commandId}`,
        rank: 0,
      })
      const item = draft(id, event.itemId, event.at, 'done', {
        kind: 'event',
        name: 'regenerate',
        data: { commandId: event.commandId },
      })
      return append(state, [item], [])
    }
    case 'resume':
      return resume(state, event.at)
  }
}
