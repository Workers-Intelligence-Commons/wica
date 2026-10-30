// Le serveur (specs/harness.md, Boucle et autorisation) : la boucle qui interprète les
// intentions, l'exécution des outils et les appels au modèle, avec les callbacks de l'hôte.

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

/** Qui est ce client, et a-t-il le droit de lire et d'écrire cette conversation. */
export interface ClientAuth {
  authenticate(hello: { token?: string }): Promise<{ identity: unknown; from: Origin } | null>
  canAccess(identity: unknown, conversationId: string, mode: 'read' | 'write'): Promise<boolean>
}

/** Un seul processus, une seule personne : tout client est le propriétaire. */
export const localAuth: ClientAuth = {
  authenticate: async () => ({ identity: 'local', from: { channel: 'local', trust: 'owner' } }),
  canAccess: async () => true,
}

/**
 * Serveur seul sur une machine : le client qui présente le jeton d'appairage est le
 * propriétaire. La comparaison prend un temps constant pour ne rien révéler du jeton.
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

/** Ce qui attend une personne : de quoi lui envoyer une notification (téléphone). */
export type Attention =
  | { kind: 'approval' | 'question'; call: Question; to?: Destination }
  /** Une tâche s'est terminée et rien n'attend plus. */
  | { kind: 'done' }

export type HarnessOptions = {
  model: ModelAdapter
  /**
   * Outils, ou une fonction relue à chaque tour quand la liste change (MCP, modes) ; elle reçoit
   * la conversation, dont une session d'éditeur peut fixer les outils.
   */
  tools?: Tool[] | ((conversationId: string) => Tool[] | Promise<Tool[]>)
  /** Skills fournis par l'hôte (voir `@wica/skills`) : leurs consignes et leurs outils. */
  skills?: { instructions: string; tools: Tool[] }
  /** Absent : tout est autorisé, avec un avertissement unique. */
  authorize?: Authorize
  store?: Store
  policy?: Policy
  limits?: Limits
  auth?: ClientAuth
  now?: () => string
  /** Consignes pour le modèle, ajoutées à chaque requête sans entrer dans le journal. */
  instructions?: string
  /**
   * Rendu d'une réponse de la personne en parties du journal ; par défaut, le texte tel quel ou
   * le JSON de la valeur. `renderAnswer` de `@wica/tools-user` rend les réponses d'`ask_user`.
   */
  renderAnswer?: (call: Extract<Item, { kind: 'tool_call' }> | undefined, value: unknown) => Part[]
  onUserMessage?: (item: Extract<Item, { kind: 'assistant_text' }>) => void
  /** Traces avant et après chaque outil exécuté. */
  onToolStart?: (conversationId: string, call: ToolCall) => void
  onToolEnd?: (
    conversationId: string,
    call: ToolCall,
    result: { output: Part[]; isError: boolean },
  ) => void
  /**
   * Réveille une conversation pour son tour suivant. Absent : un planificateur du processus.
   * Fourni par l'hôte, il doit appeler `harness.wake(conversationId)` à chaque réveil.
   */
  scheduler?: Scheduler
  /** Sessions des clients. Absent : en mémoire du processus. */
  sessions?: SessionStore
  /** Durée de vie d'une session, prolongée à chaque reprise. 24 h par défaut. */
  sessionTtlMs?: number
  /** Durée du bail d'un tour sur sa conversation. 30 s par défaut. */
  leaseMs?: number
  /** Budget de temps d'un tour avant de rendre la main et de demander une reprise. */
  turnBudgetMs?: number
  /** Éléments ajoutés entre deux instantanés de l'état. 100 par défaut. */
  snapshotEvery?: number
  /** Attente maximale d'une commande quand un autre processus tient la conversation. 30 s par défaut. */
  commandWaitMs?: number
  /**
   * Approbateur désigné d'une conversation : ses demandes d'approbation lui sont adressées, et
   * lui seul peut y répondre. Absent : tout client autorisé à écrire répond.
   */
  approver?: (conversationId: string) => Destination | undefined
  /** Délai d'un outil confié à un client quand aucun client n'est attaché. Absent : il attend. */
  clientToolTimeoutMs?: number
  /** Une approbation, une question ou une fin de tâche attend une personne. */
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

  /** Questions posées par un outil en cours, en attente de la personne. */
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
            reject(new Error('Question interrompue.'))
          },
          { once: true },
        )
      }),
  }
  const cancelAnswers = (conversationId: string) => {
    for (const [key, pending] of pendingAnswers) {
      if (!key.startsWith(`${conversationId}:`)) continue
      pendingAnswers.delete(key)
      pending.reject(new Error('Interrompu par la personne.'))
    }
  }
  if (!options.authorize && !warnedAllowAll) {
    warnedAllowAll = true
    console.warn(
      'wica : aucune fonction authorize fournie, tous les outils sont autorisés (allowAll).',
    )
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
  /** Conversations dont un tour tourne dans ce processus. */
  const active = new Set<string>()

  const broadcast = (conversationId: string, frame: ServerFrame, event?: HarnessEvent) => {
    sinks.get(conversationId)?.forEach((s) => s(frame))
    if (event) listeners.get(conversationId)?.forEach((l) => l(event))
  }

  /** Les tours d'une conversation s'exécutent l'un après l'autre dans ce processus. */
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

  /** Un tour ; il ne lit ni n'écrit rien si un autre processus tient la conversation. */
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
   * Un réveil : un tour, puis une reprise planifiée s'il reste du travail. Un tour pris par un
   * autre processus est réessayé à l'échéance de son bail ; un tour périmé s'arrête sans bruit,
   * car celui qui l'a remplacé poursuit.
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
      // Une panne de l'hôte (Store, transport) pendant un tour : les clients et `run` l'apprennent.
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

  /** Le tour court d'une commande ; il attend qu'un autre processus libère la conversation. */
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
          // Une demande adressée à l'approbateur désigné n'accepte que sa réponse.
          const { items } = await store.load(conversationId, 0)
          const request = items.find((i) => i.kind === 'tool_call' && i.callId === command.callId)
          const to = request?.kind === 'tool_call' ? request.to : undefined
          if (
            to &&
            (from.channel !== to.channel ||
              (to.recipient !== undefined && from.author !== to.recipient))
          ) {
            throw new Error('seul l’approbateur désigné peut répondre à cette approbation')
          }
          const value = command.value as boolean | { granted?: boolean }
          const granted = value === true || (typeof value === 'object' && value?.granted === true)
          return [{ t: 'approval', callId: command.callId.slice(prefix.length), granted, from }]
        }
        const { items } = await store.load(conversationId, 0)
        const call = items.find((i) => i.kind === 'tool_call' && i.callId === command.callId)
        if (call?.kind === 'tool_call' && call.channel === 'environment') {
          // Résultat d'un outil exécuté par le client : il reste un résultat d'outil.
          const result = command.value as Partial<ClientToolResult> | null
          if (!result || !Array.isArray(result.output)) {
            throw new Error('résultat d’outil attendu : { output, isError? }')
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
   * Traite une commande : un tour court l'écrit et l'accuse, puis la suite part sans que la
   * requête attende le modèle. Une commande rejouée avec le même identifiant n'agit qu'une fois.
   */
  const handle = (conversationId: string, commandId: string, command: Command, from: Origin) => {
    const key = `${conversationId}:${commandId}`
    const existing = seen.get(key)
    if (existing) return existing
    const accepted = (async () => {
      // Réponse à une question d'un outil en cours : elle va droit à l'outil, qui tient le tour.
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

    /** Point d'entrée du planificateur de l'hôte : le tour suivant de la conversation. */
    wake,

    /**
     * Événement externe (minuteur, webhook, changement de fichier) : il entre dans le journal
     * avec sa confiance, puis la conversation se réveille. Une livraison répétée du même
     * événement ne forme qu'un élément.
     */
    async external(
      conversationId: string,
      event: { source: string; name: string; data: unknown; trust: Trust },
    ) {
      await write(conversationId, [{ t: 'external_event', ...event }])
      await scheduler.wake(conversationId)
    },

    /** Sert le protocole client sur un transport, jusqu'à sa fermeture. */
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
            // Une session encore valide évite de renégocier ; perdue, elle coûte une authentification.
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
              send({ kind: 'error', message: 'authentification refusée' })
              continue
            }
            await sessions.put(identity)
            send({ kind: 'welcome', version: PROTOCOL_VERSION, sessionId: identity.id, resumed })
            continue
          }
          if (!identity) {
            send({ kind: 'error', message: 'hello attendu' })
            continue
          }
          if (frame.kind === 'subscribe') {
            if (!(await auth.canAccess(identity.identity, frame.conversationId, 'read'))) {
              send({ kind: 'error', message: 'accès refusé' })
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
            send({ kind: 'ack', commandId: envelope.commandId, ok: false, error: 'accès refusé' })
            continue
          }
          const session = identity
          const ack = () => send({ kind: 'ack', commandId: envelope.commandId, ok: true })
          // Commande déjà traitée dans cette session (accusé perdu) : elle n'agit pas deux fois.
          // Le `clientSeq` est propre à chaque client ; par une boîte de commandes, plusieurs
          // clients partagent une connexion, d'où la clé de la session du client dans celle-ci.
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
          // Plus aucun client attaché : l'échéance des outils confiés à un client commence.
          if (options.clientToolTimeoutMs !== undefined && !sinks.get(conversationId)?.size) {
            void scheduler.wake(conversationId).catch(() => {})
          }
        }
      }
    },

    /** Un flux d'événements en une ligne : envoie le message et suit la conversation. */
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
          // Une question en attente laisse le flux ouvert : la réponse arrive par `answer`.
          if (event.type === 'done' && event.waiting === 0) return
        }
      } finally {
        set.delete(listener)
      }
    },

    /** Répond à une question ou à une approbation, puis la conversation reprend. */
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
