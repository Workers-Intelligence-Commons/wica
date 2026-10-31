// The server: the loop that interprets the intents, runs the tools and calls the model, with the
// host callbacks.

import {
  APPROVAL_TOOL,
  approvalCallId,
  type Destination,
  type Item,
  type Origin,
  type Part,
  type Policy,
  type Question,
  type ToolCall,
  type Trust,
} from '@wica/core'
import {
  type ClientToolResult,
  type Command,
  type Envelope,
  PROTOCOL_VERSION,
  type ServerFrame,
  type ServerTransport,
} from '@wica/protocol'

import {
  memoryScheduler,
  MemorySessionStore,
  type Scheduler,
  type Session,
  type SessionStore,
} from './hosting.ts'
import { MemoryStore, StaleEpochError, type Store } from './store.ts'
import type { Authorize, Tool } from './tool.ts'
import {
  type Answer,
  type AnswerRegistry,
  ConversationBusyError,
  type EventBody,
  type Limits,
  type ModelAdapter,
  runTurn,
} from './turn.ts'

/** Who this client is, and whether it has the right to read and write this conversation. */
export interface ClientAuth {
  authenticate(hello: { token?: string }): Promise<{ identity: unknown; from: Origin } | null>
  canAccess(identity: unknown, conversationId: string, mode: 'read' | 'write'): Promise<boolean>
}

/** A single process, a single person: every client is the owner. */
export const localAuth: ClientAuth = {
  authenticate: async () => ({ identity: 'local', from: { channel: 'local', trust: 'owner' } }),
  canAccess: async () => true,
}

/**
 * Server alone on a machine: the client that presents the pairing token is the owner. The
 * comparison takes constant time so that it reveals nothing about the token.
 */
export function pairingTokenAuth(token: string): ClientAuth {
  const expected = new TextEncoder().encode(token)
  const same = (given: string | undefined) => {
    const bytes = new TextEncoder().encode(given ?? '')
    let diff = bytes.length ^ expected.length
    for (let i = 0; i < expected.length; i++) diff |= (bytes[i] ?? 0) ^ (expected[i] ?? 0)
    return diff === 0
  }
  return {
    authenticate: async ({ token: given }) =>
      same(given) ? { identity: 'owner', from: { channel: 'local', trust: 'owner' } } : null,
    canAccess: async (identity) => identity === 'owner',
  }
}

export type HarnessEvent =
  | { type: 'item'; item: Item }
  | { type: 'delta'; itemId: string; text: string }
  | { type: 'question'; question: Question }
  | { type: 'error'; message: string }
  | { type: 'done'; limited: boolean; waiting: number }

/** What waits for a person: what is needed to send them a notification (phone). */
export type Attention =
  | { kind: 'approval' | 'question'; call: Question; to?: Destination }
  /** A task has finished and nothing waits anymore. */
  | { kind: 'done' }

export type HarnessOptions = {
  model: ModelAdapter
  /**
   * Tools, or a function read again at each turn when the list changes (MCP, modes); it receives
   * the conversation, whose tools an editor session can set.
   */
  tools?: Tool[] | ((conversationId: string) => Tool[] | Promise<Tool[]>)
  /** Skills provided by the host (see `@wica/skills`): their instructions and their tools. */
  skills?: { instructions: string; tools: Tool[] }
  /** Absent: everything is allowed, with a one-time warning. */
  authorize?: Authorize
  store?: Store
  policy?: Policy
  limits?: Limits
  auth?: ClientAuth
  now?: () => string
  /** Instructions for the model, added to each request without entering the journal. */
  instructions?: string
  /**
   * Rendering of an answer from the person into journal parts; by default, the text as it is or
   * the JSON of the value. `renderAnswer` from `@wica/tools-user` renders the `ask_user` answers.
   */
  renderAnswer?: (call: Extract<Item, { kind: 'tool_call' }> | undefined, value: unknown) => Part[]
  onUserMessage?: (item: Extract<Item, { kind: 'assistant_text' }>) => void
  /** Traces before and after each tool that runs. */
  onToolStart?: (conversationId: string, call: ToolCall) => void
  onToolEnd?: (
    conversationId: string,
    call: ToolCall,
    result: { output: Part[]; isError: boolean },
  ) => void
  /**
   * Wakes a conversation for its next turn. Absent: a process scheduler. When provided by the
   * host, it must call `harness.wake(conversationId)` at each wake-up.
   */
  scheduler?: Scheduler
  /** Client sessions. Absent: in the process memory. */
  sessions?: SessionStore
  /** Lifetime of a session, extended at each resume. 24 h by default. */
  sessionTtlMs?: number
  /** Duration of a turn's lease on its conversation. 30 s by default. */
  leaseMs?: number
  /** Time budget of a turn before handing back control and asking for a resume. */
  turnBudgetMs?: number
  /** Items added between two state snapshots. 100 by default. */
  snapshotEvery?: number
  /** Maximum wait of a command when another process holds the conversation. 30 s by default. */
  commandWaitMs?: number
  /**
   * Designated approver of a conversation: its approval requests are addressed to them, and only
   * they can answer. Absent: every client allowed to write answers.
   */
  approver?: (conversationId: string) => Destination | undefined
  /** Delay of a tool delegated to a client when no client is attached. Absent: it waits. */
  clientToolTimeoutMs?: number
  /** An approval, a question or the end of a task waits for a person. */
  onAttentionNeeded?: (conversationId: string, attention: Attention) => void
}

type Sink = (frame: ServerFrame) => void

const toParts = (value: unknown): Part[] => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
]

let warnedAllowAll = false

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createHarness(options: HarnessOptions) {
  const store = options.store ?? new MemoryStore()
  const tools = async (conversationId: string): Promise<Tool[]> => {
    const own =
      typeof options.tools === 'function'
        ? await options.tools(conversationId)
        : (options.tools ?? [])
    return [...own, ...(options.skills?.tools ?? [])]
  }
  const instructions =
    [options.instructions, options.skills?.instructions].filter(Boolean).join('\n\n') || undefined

  /** Questions asked by a running tool, waiting for the person. */
  const pendingAnswers = new Map<
    string,
    { resolve: (a: Answer) => void; reject: (e: Error) => void }
  >()
  const answers: AnswerRegistry = {
    wait: (conversationId, callId, signal) =>
      new Promise<Answer>((resolve, reject) => {
        const key = `${conversationId}:${callId}`
        pendingAnswers.set(key, { resolve, reject })
        signal.addEventListener(
          'abort',
          () => {
            pendingAnswers.delete(key)
            reject(new Error('Question interrupted.'))
          },
          { once: true },
        )
      }),
  }
  const cancelAnswers = (conversationId: string) => {
    for (const [key, pending] of pendingAnswers) {
      if (!key.startsWith(`${conversationId}:`)) continue
      pendingAnswers.delete(key)
      pending.reject(new Error('Interrupted by the person.'))
    }
  }
  if (!options.authorize && !warnedAllowAll) {
    warnedAllowAll = true
    console.warn('wica: no authorize function provided, every tool is allowed (allowAll).')
  }
  const auth = options.auth ?? localAuth
  const sessions = options.sessions ?? new MemorySessionStore()
  const sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000
  const ownScheduler = options.scheduler ? null : memoryScheduler()
  const scheduler: Scheduler = options.scheduler ?? (ownScheduler as Scheduler)
  const sinks = new Map<string, Set<Sink>>()
  const listeners = new Map<string, Set<(e: HarnessEvent) => void>>()
  const queues = new Map<string, Promise<unknown>>()
  const seen = new Map<string, Promise<void>>()
  /** Conversations with a turn running in this process. */
  const active = new Set<string>()

  const broadcast = (conversationId: string, frame: ServerFrame, event?: HarnessEvent) => {
    sinks.get(conversationId)?.forEach((s) => s(frame))
    if (event) listeners.get(conversationId)?.forEach((l) => l(event))
  }

  /** The turns of a conversation run one after the other in this process. */
  const enqueue = <T>(conversationId: string, job: () => Promise<T>): Promise<T> => {
    const previous = queues.get(conversationId) ?? Promise.resolve()
    const next = previous.then(job, job)
    queues.set(
      conversationId,
      next.catch(() => {}),
    )
    return next
  }

  const approverOf = (conversationId: string) => {
    const approver = options.approver?.(conversationId)
    return approver ? { approver } : {}
  }
  const nowMs = () => Date.parse(options.now?.() ?? new Date().toISOString())

  /** A turn; it reads and writes nothing if another process holds the conversation. */
  const turn = (conversationId: string, events: EventBody[], maxIntents?: number) =>
    enqueue(conversationId, async () => {
      const salt = (await store.load(conversationId, Number.MAX_SAFE_INTEGER)).salt
      return runTurn({
        store,
        model: options.model,
        tools: await tools(conversationId),
        answers,
        conversationId,
        events,
        attached: (sinks.get(conversationId)?.size ?? 0) > 0,
        ...(options.authorize ? { authorize: options.authorize } : {}),
        ...(options.policy ? { policy: options.policy } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(instructions ? { instructions } : {}),
        ...(maxIntents !== undefined ? { maxIntents } : {}),
        ...(options.turnBudgetMs !== undefined ? { budgetMs: options.turnBudgetMs } : {}),
        ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
        ...(options.snapshotEvery !== undefined ? { snapshotEvery: options.snapshotEvery } : {}),
        ...approverOf(conversationId),
        ...(options.clientToolTimeoutMs !== undefined
          ? { clientToolTimeoutMs: options.clientToolTimeoutMs }
          : {}),
        observer: {
          items: (items) => {
            broadcast(conversationId, { kind: 'items', conversationId, salt, items })
            for (const item of items) {
              listeners.get(conversationId)?.forEach((l) => l({ type: 'item', item }))
              if (
                item.kind === 'assistant_text' &&
                item.audience === 'user' &&
                item.status === 'done'
              ) {
                options.onUserMessage?.(item)
              }
            }
          },
          delta: (itemId, text) =>
            broadcast(
              conversationId,
              { kind: 'delta', conversationId, itemId, text },
              { type: 'delta', itemId, text },
            ),
          head: (itemId) => broadcast(conversationId, { kind: 'head', conversationId, itemId }),
          progress: (callId, message) =>
            broadcast(conversationId, { kind: 'progress', conversationId, callId, message }),
          toolStart: (call) => options.onToolStart?.(conversationId, call),
          toolEnd: (call, result) => options.onToolEnd?.(conversationId, call, result),
        },
      })
    })

  const status = (conversationId: string, running: boolean) => {
    if (running === active.has(conversationId)) return
    if (running) active.add(conversationId)
    else active.delete(conversationId)
    broadcast(conversationId, { kind: 'status', conversationId, running })
  }

  const fail = (conversationId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    broadcast(
      conversationId,
      { kind: 'error', conversationId, message },
      { type: 'error', message },
    )
  }

  /**
   * A wake-up: a turn, then a scheduled resume if work remains. A turn taken by another process
   * is retried when its lease expires; a stale turn stops silently, because the one that replaced
   * it carries on.
   */
  const wake = async (conversationId: string): Promise<void> => {
    status(conversationId, true)
    let result
    try {
      result = await turn(conversationId, [])
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        return scheduler.wake(conversationId, { afterMs: error.busyForMs })
      }
      status(conversationId, false)
      if (error instanceof StaleEpochError) return
      // A host failure (Store, transport) during a turn: the clients and `run` learn about it.
      fail(conversationId, error)
      listeners.get(conversationId)?.forEach((l) => l({ type: 'done', limited: false, waiting: 0 }))
      return
    }
    if (!result.done) return scheduler.wake(conversationId)
    status(conversationId, false)
    if (result.wakeAt) {
      await scheduler.wake(conversationId, {
        afterMs: Math.max(0, Date.parse(result.wakeAt) - nowMs()),
      })
    }
    attention(conversationId, result)
    if (result.error) fail(conversationId, result.error)
    result.waiting.forEach((question) =>
      listeners.get(conversationId)?.forEach((l) => l({ type: 'question', question })),
    )
    listeners
      .get(conversationId)
      ?.forEach((l) => l({ type: 'done', limited: result.limited, waiting: result.waiting.length }))
  }
  ownScheduler?.bind(wake)

  const attention = (conversationId: string, result: Awaited<ReturnType<typeof turn>>) => {
    if (!options.onAttentionNeeded) return
    for (const call of result.asked) {
      const item = result.state.items.find(
        (i) => i.kind === 'tool_call' && i.callId === call.callId,
      )
      const to = item?.kind === 'tool_call' ? item.to : undefined
      options.onAttentionNeeded(conversationId, {
        kind: call.tool === APPROVAL_TOOL ? 'approval' : 'question',
        call,
        ...(to ? { to } : {}),
      })
    }
    if (result.worked && result.waiting.length === 0 && !result.error) {
      options.onAttentionNeeded(conversationId, { kind: 'done' })
    }
  }

  /** The short turn of a command; it waits for another process to release the conversation. */
  const write = async (conversationId: string, events: EventBody[]) => {
    const deadline = Date.now() + (options.commandWaitMs ?? 30_000)
    for (;;) {
      try {
        return await turn(conversationId, events, 0)
      } catch (error) {
        if (!(error instanceof ConversationBusyError) || Date.now() >= deadline) throw error
        await sleep(Math.min(error.busyForMs, 100))
      }
    }
  }

  const render = async (conversationId: string, callId: string, value: unknown) => {
    if (!options.renderAnswer) return toParts(value)
    const { items } = await store.load(conversationId, 0)
    const call = items.find(
      (i): i is Extract<Item, { kind: 'tool_call' }> =>
        i.kind === 'tool_call' && i.callId === callId,
    )
    return options.renderAnswer(call, value)
  }

  const toEvents = async (
    conversationId: string,
    command: Command,
    commandId: string,
    from: Origin,
  ): Promise<EventBody[]> => {
    switch (command.t) {
      case 'send':
        return [{ t: 'user_message', parentId: command.parentId, parts: command.parts, from }]
      case 'answer': {
        const prefix = approvalCallId('')
        if (command.callId.startsWith(prefix)) {
          // A request addressed to the designated approver accepts only their answer.
          const { items } = await store.load(conversationId, 0)
          const request = items.find((i) => i.kind === 'tool_call' && i.callId === command.callId)
          const to = request?.kind === 'tool_call' ? request.to : undefined
          if (
            to &&
            (from.channel !== to.channel ||
              (to.recipient !== undefined && from.author !== to.recipient))
          ) {
            throw new Error('only the designated approver can answer this approval')
          }
          const value = command.value as boolean | { granted?: boolean }
          const granted = value === true || (typeof value === 'object' && value?.granted === true)
          return [{ t: 'approval', callId: command.callId.slice(prefix.length), granted, from }]
        }
        const { items } = await store.load(conversationId, 0)
        const call = items.find((i) => i.kind === 'tool_call' && i.callId === command.callId)
        if (call?.kind === 'tool_call' && call.channel === 'environment') {
          // Result of a tool run by the client: it stays a tool result.
          const result = command.value as Partial<ClientToolResult> | null
          if (!result || !Array.isArray(result.output)) {
            throw new Error('tool result expected: { output, isError? }')
          }
          return [
            {
              t: 'tool_result',
              callId: command.callId,
              output: result.output,
              ...(result.isError ? { isError: true } : {}),
              from,
            },
          ]
        }
        const output = await render(conversationId, command.callId, command.value)
        return [{ t: 'tool_result', callId: command.callId, output, from }]
      }
      case 'set_head':
        return [{ t: 'set_head', itemId: command.itemId }]
      case 'regenerate':
        return [{ t: 'regenerate', itemId: command.itemId, commandId }]
      case 'interrupt':
        return []
    }
  }

  /**
   * Processes a command: a short turn writes and acknowledges it, then the rest leaves without the
   * request waiting for the model. A command replayed with the same identifier acts only once.
   */
  const handle = (conversationId: string, commandId: string, command: Command, from: Origin) => {
    const key = `${conversationId}:${commandId}`
    const existing = seen.get(key)
    if (existing) return existing
    const accepted = (async () => {
      // Answer to a question of a running tool: it goes straight to the tool, which holds the turn.
      const pending =
        command.t === 'answer'
          ? pendingAnswers.get(`${conversationId}:${command.callId}`)
          : undefined
      if (command.t === 'answer' && pending) {
        pendingAnswers.delete(`${conversationId}:${command.callId}`)
        const output = await render(conversationId, command.callId, command.value)
        pending.resolve({ value: command.value, output, from })
        return
      }
      if (command.t === 'interrupt') {
        await store.requestInterrupt(conversationId)
        cancelAnswers(conversationId)
      } else {
        await write(conversationId, await toEvents(conversationId, command, commandId, from))
      }
      await scheduler.wake(conversationId)
    })()
    seen.set(key, accepted)
    return accepted
  }

  return {
    store,

    /** Entry point of the host scheduler: the next turn of the conversation. */
    wake,

    /**
     * External event (timer, webhook, file change): it enters the journal with its trust, then
     * the conversation wakes up. A repeated delivery of the same event forms only one item.
     */
    async external(
      conversationId: string,
      event: { source: string; name: string; data: unknown; trust: Trust },
    ) {
      await write(conversationId, [{ t: 'external_event', ...event }])
      await scheduler.wake(conversationId)
    },

    /** Serves the client protocol on a transport, until it closes. */
    async serve(transport: ServerTransport): Promise<void> {
      let identity: Session | null = null
      const subscriptions = new Map<string, Sink>()
      const send = (frame: ServerFrame) => void transport.send(frame).catch(() => {})
      try {
        for await (const frame of transport.receive()) {
          if (frame.kind === 'ping') {
            send({ kind: 'pong' })
            continue
          }
          if (frame.kind === 'hello') {
            // A session still valid avoids negotiating again; lost, it costs an authentication.
            const known = frame.sessionId ? await sessions.get(frame.sessionId) : undefined
            const resumed = known !== undefined && known.expiresAt > Date.now()
            let session: Session | null = resumed ? known : null
            if (!session) {
              const found = await auth.authenticate(
                frame.token !== undefined ? { token: frame.token } : {},
              )
              if (found) session = { id: crypto.randomUUID(), ...found, expiresAt: 0 }
            }
            identity = session && { ...session, expiresAt: Date.now() + sessionTtlMs }
            if (!identity) {
              send({ kind: 'error', message: 'authentication refused' })
              continue
            }
            await sessions.put(identity)
            send({ kind: 'welcome', version: PROTOCOL_VERSION, sessionId: identity.id, resumed })
            continue
          }
          if (!identity) {
            send({ kind: 'error', message: 'hello expected' })
            continue
          }
          if (frame.kind === 'subscribe') {
            if (!(await auth.canAccess(identity.identity, frame.conversationId, 'read'))) {
              send({ kind: 'error', message: 'access denied' })
              continue
            }
            const loaded = await store.load(frame.conversationId, frame.fromSeq)
            send({
              kind: 'items',
              conversationId: frame.conversationId,
              salt: loaded.salt,
              items: loaded.items,
            })
            if (loaded.head)
              send({ kind: 'head', conversationId: frame.conversationId, itemId: loaded.head })
            send({
              kind: 'status',
              conversationId: frame.conversationId,
              running: active.has(frame.conversationId),
            })
            const sink: Sink = send
            subscriptions.set(frame.conversationId, sink)
            const set = sinks.get(frame.conversationId) ?? new Set()
            set.add(sink)
            sinks.set(frame.conversationId, set)
            continue
          }
          if (frame.kind === 'unsubscribe') {
            const sink = subscriptions.get(frame.conversationId)
            if (sink) sinks.get(frame.conversationId)?.delete(sink)
            continue
          }
          const envelope: Envelope = frame
          if (!(await auth.canAccess(identity.identity, envelope.conversationId, 'write'))) {
            send({ kind: 'ack', commandId: envelope.commandId, ok: false, error: 'access denied' })
            continue
          }
          const session = identity
          const ack = () => send({ kind: 'ack', commandId: envelope.commandId, ok: true })
          // Command already processed in this session (lost acknowledgement): it does not act twice.
          // The `clientSeq` belongs to each client; through a command inbox, several clients share
          // a connection, hence the key of the client session inside this one.
          const key = `${session.id}:${envelope.sessionId}`
          const last = await sessions.lastCommand(key, envelope.conversationId)
          if (last !== undefined && envelope.clientSeq <= last) {
            ack()
            continue
          }
          handle(envelope.conversationId, envelope.commandId, envelope.command, session.from)
            .then(() => sessions.recordCommand(key, envelope.conversationId, envelope.clientSeq))
            .then(ack, (error: unknown) =>
              send({ kind: 'ack', commandId: envelope.commandId, ok: false, error: String(error) }),
            )
        }
      } finally {
        for (const [conversationId, sink] of subscriptions) {
          sinks.get(conversationId)?.delete(sink)
          // No client attached anymore: the deadline of the tools delegated to a client starts.
          if (options.clientToolTimeoutMs !== undefined && !sinks.get(conversationId)?.size) {
            void scheduler.wake(conversationId).catch(() => {})
          }
        }
      }
    },

    /** An event stream in one line: sends the message and follows the conversation. */
    async *run(
      prompt: string | Part[],
      o: { conversationId?: string; from?: Origin } = {},
    ): AsyncIterable<HarnessEvent> {
      const conversationId = o.conversationId ?? crypto.randomUUID()
      const from = o.from ?? { channel: 'local', trust: 'owner' }
      const queue: HarnessEvent[] = []
      let wake: () => void = () => {}
      const listener = (e: HarnessEvent) => {
        queue.push(e)
        wake()
      }
      const set = listeners.get(conversationId) ?? new Set()
      set.add(listener)
      listeners.set(conversationId, set)
      try {
        const { head } = await store.load(conversationId, Number.MAX_SAFE_INTEGER)
        const parts: Part[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
        await handle(
          conversationId,
          crypto.randomUUID(),
          { t: 'send', parentId: head, parts },
          from,
        )
        for (;;) {
          while (queue.length === 0) await new Promise<void>((r) => (wake = r))
          const event = queue.shift() as HarnessEvent
          yield event
          // A pending question leaves the stream open: the answer arrives through `answer`.
          if (event.type === 'done' && event.waiting === 0) return
        }
      } finally {
        set.delete(listener)
      }
    },

    /** Answers a question or an approval, then the conversation resumes. */
    answer(conversationId: string, callId: string, value: unknown, from?: Origin) {
      return handle(
        conversationId,
        crypto.randomUUID(),
        { t: 'answer', callId, value },
        from ?? { channel: 'local', trust: 'owner' },
      )
    },

    interrupt(conversationId: string) {
      return handle(
        conversationId,
        crypto.randomUUID(),
        { t: 'interrupt' },
        { channel: 'local', trust: 'owner' },
      )
    },
  }
}

export type Harness = ReturnType<typeof createHarness>
