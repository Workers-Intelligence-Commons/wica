// A turn: claim the conversation, rebuild the state from the journal, pass the received events
// to `step`, run the intents, write, then continue or stop.

import {
  type AssistantMessage,
  CANCEL_WAKEUP_TOOL,
  type Delta,
  type Destination,
  type Event,
  initialState,
  type Intent,
  type Item,
  type ModelRequest,
  type Part,
  pathTo,
  type Policy,
  type Question,
  type State,
  step,
  type ToolCall,
  type Trust,
  elicitCallId,
  type Origin,
  SCHEDULE_TOOL,
} from '@wica/core'

import { type Snapshot, StaleEpochError, type Store } from './store.ts'
import { type Authorize, isDestructive, type Tool } from './tool.ts'

export type EventBody = Event extends infer E ? (E extends unknown ? Omit<E, 'at'> : never) : never

export type ModelChunk = Delta | { type: 'done'; message: AssistantMessage }

export interface ModelAdapter {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>
}

/** What the server pushes to the subscribed clients, after writing. */
export type Observer = {
  items?: (items: Item[]) => void
  delta?: (itemId: string, text: string) => void
  head?: (itemId: string) => void
  progress?: (callId: string, message: string) => void
  /** Host traces before and after each tool that runs. */
  toolStart?: (call: ToolCall) => void
  toolEnd?: (call: ToolCall, result: { output: Part[]; isError: boolean }) => void
}

export type Limits = {
  /** Model calls per turn. */
  maxModelCalls?: number
  /** Maximum size, in characters, of the text of a tool result kept in the journal. */
  maxResultChars?: number
  /**
   * Total duration of a turn, in milliseconds. Checked between two intents: the turn then stops
   * with `limited`, without cutting an intent in progress.
   */
  maxDurationMs?: number
}

export type TurnOptions = {
  store: Store
  model: ModelAdapter
  tools: Tool[]
  conversationId: string
  authorize?: Authorize
  /** Trust of the input that triggers this turn, passed to `authorize`. */
  trust?: Trust
  attached?: boolean
  /** Time provided to the events: the core never reads the clock. */
  now?: () => string
  events?: EventBody[]
  policy?: Policy
  /** Number of work intents run before handing back control and asking for a resume. */
  maxIntents?: number
  /**
   * Time budget of the turn, in milliseconds: past this delay, the turn hands back control between
   * two intents and asks for a resume (`done: false`). Serves platforms with a limited duration.
   */
  budgetMs?: number
  /** Duration of the lease set by the claim, extended as long as the turn lives. 30 s by default. */
  leaseMs?: number
  /** Items added since the last snapshot before writing a new one. 100 by default. */
  snapshotEvery?: number
  limits?: Limits
  observer?: Observer
  signal?: AbortSignal
  /** Host instructions, added to each model request. */
  instructions?: string
  /** Answers to the questions asked by a running tool; without a registry, `ctx.ask` fails. */
  answers?: AnswerRegistry
  /** Designated approver of the conversation: its approval requests are addressed to them. */
  approver?: Destination
  /**
   * Delay of a tool delegated to a client when no client is attached: past this delay, the call
   * receives a dedicated error instead of waiting forever. Absent: it waits.
   */
  clientToolTimeoutMs?: number
}

export type Answer = { value: unknown; output: Part[]; from?: Origin }

/** Delivers to a tool that waits for the answer to its question. Provided by the server. */
export interface AnswerRegistry {
  wait(conversationId: string, callId: string, signal: AbortSignal): Promise<Answer>
}

export type TurnResult = {
  state: State
  /** Questions and approvals waiting for the person. */
  waiting: Question[]
  /** False when the turn stops with work remaining: the host schedules a resume. */
  done: boolean
  /** True when a limit stopped the turn. */
  limited: boolean
  /** Failure of the model service that stopped the turn. */
  error?: Error
  /** Time at which to wake the conversation: scheduled wake-up, deadline of a wait. */
  wakeAt?: string
  /** Questions and approvals written by this turn, waiting for the person. */
  asked: Question[]
  /** True when the turn ran work (model or tool). */
  worked: boolean
}

type Outcome = Omit<TurnResult, 'wakeAt' | 'asked' | 'worked'>

type Work = Extract<Intent, { t: 'call_model' } | { t: 'run_tool' } | { t: 'ask_user' }>

const text = (t: string): Part[] => [{ type: 'text', text: t }]

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/**
 * Trust of the input that triggered the work in progress: the last message from a person or
 * external event of the path. A stateless turn finds it this way in the journal.
 */
export function triggerTrust(path: readonly Item[]): Trust {
  const trigger = path.findLast((i) => i.kind === 'user_message' || i.kind === 'external_event')
  if (trigger?.kind === 'external_event') return trigger.trust
  if (trigger?.kind === 'user_message') return trigger.from?.trust ?? 'owner'
  return 'owner'
}

/** Another turn holds the conversation: retry after `busyForMs`. */
export class ConversationBusyError extends Error {
  override name = 'ConversationBusyError'
  readonly busyForMs: number
  constructor(busyForMs: number) {
    super(`conversation held by another turn for another ${busyForMs} ms`)
    this.busyForMs = busyForMs
  }
}

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_SNAPSHOT_EVERY = 100

/**
 * Snapshot of the settled items: everything up to the first item still streaming, which a
 * following turn can still settle. Nothing of a snapshot therefore changes after it is written.
 */
export function takeSnapshot(items: readonly Item[]): Snapshot | undefined {
  const sorted = [...items].sort((a, b) => a.seq - b.seq)
  const open = sorted.findIndex((i) => i.status === 'streaming')
  const settled = open === -1 ? sorted : sorted.slice(0, open)
  const last = settled.at(-1)
  return last ? { schema: 1, seq: last.seq, items: settled } : undefined
}

/** Stop requested by the person: the turn cleanly closes what is open. */
class Interrupted extends Error {}

/** The model service failed after its retries. */
class ModelFailed extends Error {
  readonly error: Error
  constructor(error: Error) {
    super(error.message)
    this.error = error
  }
}

const truncate = (parts: Part[], max: number | undefined): Part[] =>
  max === undefined
    ? parts
    : parts.map((p) =>
        p.type === 'text' && p.text.length > max
          ? {
              type: 'text',
              text: `${p.text.slice(0, max)}\n[truncated: ${p.text.length - max} characters]`,
            }
          : p,
      )

async function turn(o: TurnOptions): Promise<TurnResult> {
  const id = o.conversationId
  const startedAt = Date.now()
  const abort = new AbortController()
  o.signal?.addEventListener('abort', () => abort.abort(o.signal?.reason), { once: true })
  const leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS
  const claimed = await o.store.claim(id, leaseMs)
  if (!('epoch' in claimed)) throw new ConversationBusyError(claimed.busyForMs)
  const { epoch } = claimed
  // The lease is extended as long as the turn lives; taken over by another turn, this one stops
  // without writing. A transient failure (network down) stops nothing: the running tool finishes.
  let lost: Error | null = null
  let renewing = false
  const renewal = setInterval(() => {
    if (renewing) return
    renewing = true
    o.store
      .renew(id, epoch)
      .catch((error: unknown) => {
        if (!(error instanceof StaleEpochError)) return
        lost = error
        abort.abort(lost)
      })
      .finally(() => (renewing = false))
  }, leaseMs / 3)
  try {
    return await claimedTurn(o, epoch, abort, () => lost, startedAt)
  } catch (error) {
    throw lost ?? error
  } finally {
    clearInterval(renewal)
    await o.store.release(id, epoch).catch(() => {})
  }
}

async function claimedTurn(
  o: TurnOptions,
  epoch: number,
  abort: AbortController,
  lostLease: () => Error | null,
  startedAt: number,
): Promise<TurnResult> {
  const id = o.conversationId
  const now = o.now ?? (() => new Date().toISOString())
  const { signal } = abort
  const snapshot = await o.store.loadSnapshot(id)
  const loaded = await o.store.load(id, snapshot?.seq ?? 0)
  let state = initialState({
    conversationId: id,
    salt: loaded.salt,
    items: [...(snapshot?.items ?? []), ...loaded.items],
    head: loaded.head,
    ...(o.policy ? { policy: o.policy } : {}),
  })
  const batchIndex = new Map<string, number>()
  let interruptRequested = loaded.interruptRequested
  const startSeq = state.maxSeq
  /** Wake-ups requested by the last resume: what remains to wait for when the turn stops. */
  let schedules: string[] = []

  const apply = async (event: EventBody): Promise<Work[]> => {
    const before = state.head
    const result = step(state, { ...event, at: now() } as Event)
    state = result.state
    const work: Work[] = []
    for (const intent of result.intents) {
      switch (intent.t) {
        case 'persist': {
          const res = await o.store.append(id, intent.items, epoch)
          interruptRequested ||= res.interruptRequested
          state = step(state, { t: 'persisted', items: res.persisted, at: now() }).state
          o.observer?.items?.(state.items.filter((i) => intent.items.some((d) => d.id === i.id)))
          break
        }
        case 'append_delta': {
          const idx = batchIndex.get(intent.itemId) ?? 0
          batchIndex.set(intent.itemId, idx + 1)
          const res = await o.store.appendBatch(id, intent.itemId, idx, intent.text, epoch)
          interruptRequested ||= res.interruptRequested
          o.observer?.delta?.(intent.itemId, intent.text)
          break
        }
        case 'settle': {
          await o.store.settle(id, intent.item, epoch)
          const settled = state.items.find((i) => i.id === intent.item.id)
          if (settled) o.observer?.items?.([settled])
          break
        }
        case 'call_model':
        case 'run_tool':
        case 'ask_user':
          work.push(intent)
          break
        case 'schedule':
          schedules.push(intent.at)
          break
        case 'to_user':
          break
      }
    }
    if (event.t === 'set_head' && state.head !== before && state.head !== null) {
      await o.store.setHead(id, state.head, epoch)
    }
    if (state.head !== before && state.head !== null) o.observer?.head?.(state.head)
    return work
  }

  /** The requested interruption is seen at each write: the turn stops at the next batch. */
  const checkInterrupt = () => {
    if (!interruptRequested) return
    abort.abort(new Error('interrupted'))
    throw new Interrupted()
  }

  /** Summary request: only the final text counts, and it becomes the `compacted` event. */
  const summarize = async (request: ModelRequest, range: { from: string; to: string }) => {
    let summary = ''
    try {
      for await (const chunk of o.model.stream(request, signal)) {
        checkInterrupt()
        if (chunk.type !== 'done') continue
        summary = chunk.message.parts
          .flatMap((p) => (p.type === 'text' ? [p.text] : []))
          .join('\n')
          .trim()
      }
    } catch (error) {
      if (error instanceof Interrupted) throw error
      throw signal.aborted ? new Interrupted() : new ModelFailed(asError(error))
    }
    // An empty summary would erase the past from the model view: the turn stops instead.
    if (summary === '') throw new ModelFailed(new Error('The model returned an empty summary.'))
    await apply({ t: 'compacted', ...range, summary })
  }

  const runModel = async (request: ModelRequest) => {
    const full = o.instructions ? { ...request, instructions: o.instructions } : request
    if (request.summarize) return summarize(full, request.summarize)
    const iterator = o.model.stream(full, signal)[Symbol.asyncIterator]()
    try {
      for (;;) {
        checkInterrupt()
        let next: IteratorResult<ModelChunk>
        try {
          next = await iterator.next()
        } catch (error) {
          throw signal.aborted ? new Interrupted() : new ModelFailed(asError(error))
        }
        if (next.done) break
        const chunk = next.value
        // Each chunk is written as soon as it arrives: nothing is shown before being persisted.
        if (chunk.type === 'done') await apply({ t: 'model_done', message: chunk.message })
        else await apply({ t: 'model_delta', delta: chunk })
      }
    } finally {
      await iterator.return?.()
    }
  }

  const asker = (call: ToolCall) => {
    let n = 0
    return async (input: unknown): Promise<unknown> => {
      if (!o.answers) throw new Error('No user channel to ask a question.')
      const callId = elicitCallId(call.callId, n++)
      await apply({ t: 'tool_question', callId: call.callId, n: n - 1, input })
      const answer = await o.answers.wait(id, callId, signal)
      await apply({
        t: 'tool_result',
        callId,
        output: answer.output,
        ...(answer.from ? { from: answer.from } : {}),
      })
      return answer.value
    }
  }

  const execute = async (call: ToolCall, tool: Tool | undefined) => {
    if (!tool?.run) return { output: text(`Unknown tool: ${call.tool}`), isError: true }
    try {
      const output = await tool.run(call.input, {
        callId: call.callId,
        signal,
        path: pathTo(state.items, state.head),
        progress: (message) => o.observer?.progress?.(call.callId, message),
        ask: asker(call),
      })
      return { output: truncate(output, o.limits?.maxResultChars), isError: false }
    } catch (error) {
      return { output: text(asError(error).message), isError: true }
    }
  }

  const runTool = async (call: ToolCall) => {
    const tool = o.tools.find((t) => t.spec.name === call.tool)
    if (!call.approved) {
      const annotations = tool?.spec.annotations ?? {}
      const trust = o.trust ?? triggerTrust(pathTo(state.items, state.head))
      let decision = await (o.authorize ?? (() => 'allow' as const))(
        { ...call, annotations },
        { trust, attached: o.attached ?? false },
      )
      // An untrusted input triggers a destructive tool only with an approval, whatever the host
      // policy.
      if (decision === 'allow' && trust === 'untrusted' && isDestructive(annotations)) {
        decision = { ask: `Allow ${call.tool}? The request comes from untrusted input.` }
      }
      if (typeof decision === 'object' && 'ask' in decision) {
        return apply({
          t: 'approval_needed',
          callId: call.callId,
          question: decision.ask,
          ...(o.approver ? { to: o.approver } : {}),
        })
      }
      if (decision !== 'allow') {
        const reason = decision === 'deny' ? 'Refused by the host policy.' : decision.deny
        return apply({ t: 'tool_result', callId: call.callId, output: text(reason), isError: true })
      }
    }
    // Tool run by a client (files of an editor): allowed here, run there.
    if (tool?.spec.runsOn === 'client') return apply({ t: 'tool_handed', callId: call.callId })
    // Wake-ups: the core writes them into the journal, with no effect outside the journal to claim.
    if (call.tool === SCHEDULE_TOOL) return apply({ t: 'wakeup_scheduled', callId: call.callId })
    if (call.tool === CANCEL_WAKEUP_TOOL) {
      return apply({ t: 'wakeup_cancelled', callId: call.callId })
    }
    if ((await o.store.claimToolCall(id, call.callId, epoch)) === 'already_claimed') {
      // No one knows whether the effect of the tool took place: it is never started again.
      return apply({
        t: 'tool_result',
        callId: call.callId,
        output: text('Unknown state: the previous run stopped without a result.'),
        isError: true,
      })
    }
    o.observer?.toolStart?.(call)
    const outcome = await execute(call, tool)
    o.observer?.toolEnd?.(call, outcome)
    return apply({
      t: 'tool_result',
      callId: call.callId,
      output: outcome.output,
      ...(outcome.isError ? { isError: true } : {}),
    })
  }

  /**
   * Tools delegated to a client while no client is attached: the call fails at its deadline.
   * Returns the closest deadline among those still waiting.
   */
  const clientDeadlines = async (expire: boolean): Promise<number | undefined> => {
    const timeout = o.clientToolTimeoutMs
    if (timeout === undefined || o.attached) return undefined
    const answered = new Set(
      state.items.flatMap((i) => (i.kind === 'tool_result' ? [i.callId] : [])),
    )
    const pending = state.items.flatMap((i) =>
      i.kind === 'event' &&
      i.name === 'handed' &&
      !answered.has((i.data as { callId: string }).callId)
        ? [
            {
              callId: (i.data as { callId: string }).callId,
              deadline: Date.parse(i.at) + timeout,
            },
          ]
        : [],
    )
    let next: number | undefined
    for (const { callId, deadline } of pending) {
      if (expire && deadline <= Date.parse(now())) {
        await apply({
          t: 'tool_result',
          callId,
          output: text('No attached client ran this call within the delay.'),
          isError: true,
        })
      } else {
        next = Math.min(next ?? Infinity, deadline)
      }
    }
    return next
  }

  /** What the host must also know when the turn stops. */
  const finish = async (outcome: Outcome, executed: number): Promise<TurnResult> => {
    const deadline = await clientDeadlines(false)
    const times = [...schedules.map((t) => Date.parse(t)), ...(deadline ? [deadline] : [])]
    const wakeAt = times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined
    const fresh = new Set(state.items.filter((i) => i.seq > startSeq).map((i) => i.id))
    const asked = outcome.waiting.filter((q) =>
      state.items.some((i) => i.kind === 'tool_call' && i.callId === q.callId && fresh.has(i.id)),
    )
    return { ...outcome, ...(wakeAt ? { wakeAt } : {}), asked, worked: executed > 0 }
  }

  const isReadOnly = (w: Work) =>
    w.t === 'run_tool' &&
    o.tools.find((t) => t.spec.name === w.call.tool)?.spec.annotations?.readOnlyHint === true

  let executed = 0
  const loop = async (): Promise<Outcome> => {
    await apply({ t: 'tools_changed', tools: o.tools.map((t) => t.spec) })
    if (interruptRequested) throw new Interrupted()
    for (const event of o.events ?? []) await apply(event)
    await clientDeadlines(true)

    let modelCalls = 0
    for (;;) {
      checkInterrupt()
      schedules = []
      const work = await apply({ t: 'resume' })
      const waiting = work.flatMap((w) => (w.t === 'ask_user' ? [w.question] : []))
      const runnable = work.filter((w) => w.t !== 'ask_user')
      if (runnable.length === 0) return { state, waiting, done: true, limited: false }
      if (executed >= (o.maxIntents ?? Infinity)) {
        return { state, waiting, done: false, limited: false }
      }
      // The budget counts only after an intent, otherwise a turn slow to load would do nothing.
      if (executed > 0 && Date.now() - startedAt >= (o.budgetMs ?? Infinity)) {
        return { state, waiting, done: false, limited: false }
      }
      if (Date.now() - startedAt >= (o.limits?.maxDurationMs ?? Infinity)) {
        return { state, waiting, done: true, limited: true }
      }
      const model = runnable.find((w) => w.t === 'call_model')
      if (model?.t === 'call_model') {
        if (modelCalls >= (o.limits?.maxModelCalls ?? Infinity)) {
          return { state, waiting, done: true, limited: true }
        }
        modelCalls += 1
        executed += 1
        await runModel(model.request)
        continue
      }
      // Only read-only tools run together; the others, one by one.
      const calls = (ws: Work[]) => ws.flatMap((w) => (w.t === 'run_tool' ? [w.call] : []))
      await Promise.all(calls(runnable.filter(isReadOnly)).map(runTool))
      for (const call of calls(runnable.filter((w) => !isReadOnly(w)))) await runTool(call)
      executed += runnable.length
    }
  }

  const snapshotIfDue = async (result: Outcome) => {
    const since = state.items.filter((i) => i.seq > (snapshot?.seq ?? 0)).length
    if (since < (o.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY)) return result
    const next = takeSnapshot(state.items)
    if (next && next.seq > (snapshot?.seq ?? 0)) await o.store.saveSnapshot(id, next, epoch)
    return result
  }

  try {
    return await finish(await snapshotIfDue(await loop()), executed)
  } catch (error) {
    const lost = lostLease()
    if (lost || error instanceof StaleEpochError) throw lost ?? error
    if (error instanceof ModelFailed) {
      await apply({ t: 'model_failed', error: error.message })
      return finish(
        { state, waiting: [], done: true, limited: false, error: error.error },
        executed,
      )
    }
    if (error instanceof Interrupted) {
      await apply({ t: 'interrupt' })
      await o.store.clearInterrupt(id, epoch)
      return finish({ state, waiting: [], done: true, limited: false }, executed)
    }
    throw error
  }
}

/** Runs a turn on a conversation. */
export const runTurn = (options: TurnOptions): Promise<TurnResult> => turn(options)
