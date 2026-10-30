// Un tour : réclamer la conversation, reconstruire l'état depuis le journal, passer les
// événements reçus à `step`, exécuter les intentions, écrire, puis continuer ou s'arrêter.

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

/** Ce que le serveur pousse aux clients abonnés, après écriture. */
export type Observer = {
  items?: (items: Item[]) => void
  delta?: (itemId: string, text: string) => void
  head?: (itemId: string) => void
  progress?: (callId: string, message: string) => void
  /** Traces de l'hôte avant et après chaque outil exécuté. */
  toolStart?: (call: ToolCall) => void
  toolEnd?: (call: ToolCall, result: { output: Part[]; isError: boolean }) => void
}

export type Limits = {
  /** Appels au modèle par tour. */
  maxModelCalls?: number
  /** Taille maximale, en caractères, du texte d'un résultat d'outil gardé dans le journal. */
  maxResultChars?: number
  /**
   * Durée totale d'un tour, en millisecondes. Vérifiée entre deux intentions : le tour s'arrête
   * alors avec `limited`, sans couper une intention en cours.
   */
  maxDurationMs?: number
}

export type TurnOptions = {
  store: Store
  model: ModelAdapter
  tools: Tool[]
  conversationId: string
  authorize?: Authorize
  /** Confiance de l'entrée qui déclenche ce tour, transmise à `authorize`. */
  trust?: Trust
  attached?: boolean
  /** Heure fournie aux événements : le cœur ne lit jamais l'horloge. */
  now?: () => string
  events?: EventBody[]
  policy?: Policy
  /** Nombre d'intentions de travail exécutées avant de rendre la main et de demander une reprise. */
  maxIntents?: number
  /**
   * Budget de temps du tour, en millisecondes : passé ce délai, le tour rend la main entre deux
   * intentions et demande une reprise (`done: false`). Sert aux plateformes à durée limitée.
   */
  budgetMs?: number
  /** Durée du bail posé par la réclamation, prolongé tant que le tour vit. 30 s par défaut. */
  leaseMs?: number
  /** Éléments ajoutés depuis le dernier instantané avant d'en écrire un nouveau. 100 par défaut. */
  snapshotEvery?: number
  limits?: Limits
  observer?: Observer
  signal?: AbortSignal
  /** Consignes de l'hôte, ajoutées à chaque requête au modèle. */
  instructions?: string
  /** Réponses aux questions posées par un outil en cours ; sans registre, `ctx.ask` échoue. */
  answers?: AnswerRegistry
  /** Approbateur désigné de la conversation : ses demandes d'approbation lui sont adressées. */
  approver?: Destination
  /**
   * Délai d'un outil confié à un client quand aucun client n'est attaché : passé ce délai,
   * l'appel reçoit une erreur dédiée au lieu d'attendre sans fin. Absent : il attend.
   */
  clientToolTimeoutMs?: number
}

export type Answer = { value: unknown; output: Part[]; from?: Origin }

/** Livre à un outil qui attend la réponse à sa question. Fourni par le serveur. */
export interface AnswerRegistry {
  wait(conversationId: string, callId: string, signal: AbortSignal): Promise<Answer>
}

export type TurnResult = {
  state: State
  /** Questions et approbations qui attendent la personne. */
  waiting: Question[]
  /** Faux quand le tour s'arrête avec du travail restant : l'hôte planifie une reprise. */
  done: boolean
  /** Vrai quand une limite a arrêté le tour. */
  limited: boolean
  /** Échec du service de modèle qui a arrêté le tour. */
  error?: Error
  /** Heure à laquelle réveiller la conversation : réveil prévu, échéance d'une attente. */
  wakeAt?: string
  /** Questions et approbations écrites par ce tour, qui attendent la personne. */
  asked: Question[]
  /** Vrai quand le tour a exécuté du travail (modèle ou outil). */
  worked: boolean
}

type Outcome = Omit<TurnResult, 'wakeAt' | 'asked' | 'worked'>

type Work = Extract<Intent, { t: 'call_model' } | { t: 'run_tool' } | { t: 'ask_user' }>

const text = (t: string): Part[] => [{ type: 'text', text: t }]

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/**
 * Confiance de l'entrée qui a déclenché le travail en cours : le dernier message d'une personne
 * ou événement externe du chemin. Un tour sans état la retrouve ainsi dans le journal.
 */
export function triggerTrust(path: readonly Item[]): Trust {
  const trigger = path.findLast((i) => i.kind === 'user_message' || i.kind === 'external_event')
  if (trigger?.kind === 'external_event') return trigger.trust
  if (trigger?.kind === 'user_message') return trigger.from?.trust ?? 'owner'
  return 'owner'
}

/** Un autre tour tient la conversation : réessayer après `busyForMs`. */
export class ConversationBusyError extends Error {
  override name = 'ConversationBusyError'
  readonly busyForMs: number
  constructor(busyForMs: number) {
    super(`conversation tenue par un autre tour pendant encore ${busyForMs} ms`)
    this.busyForMs = busyForMs
  }
}

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_SNAPSHOT_EVERY = 100

/**
 * Instantané des éléments réglés : tout jusqu'au premier élément encore en flux, qu'un tour
 * suivant peut encore régler. Rien d'un instantané ne change donc plus après son écriture.
 */
export function takeSnapshot(items: readonly Item[]): Snapshot | undefined {
  const sorted = [...items].sort((a, b) => a.seq - b.seq)
  const open = sorted.findIndex((i) => i.status === 'streaming')
  const settled = open === -1 ? sorted : sorted.slice(0, open)
  const last = settled.at(-1)
  return last ? { schema: 1, seq: last.seq, items: settled } : undefined
}

/** Arrêt demandé par la personne : le tour ferme proprement ce qui est ouvert. */
class Interrupted extends Error {}

/** Le service de modèle a échoué après ses réessais. */
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
              text: `${p.text.slice(0, max)}\n[tronqué : ${p.text.length - max} caractères]`,
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
  // Le bail est prolongé tant que le tour vit ; repris par un autre tour, celui-ci s'arrête sans
  // écrire. Un échec passager (réseau coupé) n'arrête rien : l'outil en cours se termine.
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
  /** Réveils demandés par la dernière reprise : ce qu'il reste à attendre quand le tour s'arrête. */
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

  /** L'interruption demandée est vue à chaque écriture : le tour s'arrête au lot suivant. */
  const checkInterrupt = () => {
    if (!interruptRequested) return
    abort.abort(new Error('interrompu'))
    throw new Interrupted()
  }

  /** Requête de résumé : seul le texte final compte, et il devient l'événement `compacted`. */
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
    // Un résumé vide effacerait le passé de la vue du modèle : le tour s'arrête plutôt.
    if (summary === '') throw new ModelFailed(new Error('Le modèle a rendu un résumé vide.'))
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
        // Chaque morceau est écrit dès son arrivée : rien n'est montré avant d'être persisté.
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
      if (!o.answers) throw new Error('Aucun canal utilisateur pour poser une question.')
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
    if (!tool?.run) return { output: text(`Outil inconnu : ${call.tool}`), isError: true }
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
      // Une entrée non fiable ne déclenche un outil destructif qu'avec une approbation, quelle
      // que soit la politique de l'hôte.
      if (decision === 'allow' && trust === 'untrusted' && isDestructive(annotations)) {
        decision = { ask: `Autoriser ${call.tool} ? La demande vient d'une entrée non fiable.` }
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
        const reason = decision === 'deny' ? 'Refusé par la politique de l’hôte.' : decision.deny
        return apply({ t: 'tool_result', callId: call.callId, output: text(reason), isError: true })
      }
    }
    // Outil exécuté par un client (fichiers d'un éditeur) : autorisé ici, exécuté là-bas.
    if (tool?.spec.runsOn === 'client') return apply({ t: 'tool_handed', callId: call.callId })
    // Réveils : le cœur les écrit dans le journal, sans effet hors du journal à réclamer.
    if (call.tool === SCHEDULE_TOOL) return apply({ t: 'wakeup_scheduled', callId: call.callId })
    if (call.tool === CANCEL_WAKEUP_TOOL) {
      return apply({ t: 'wakeup_cancelled', callId: call.callId })
    }
    if ((await o.store.claimToolCall(id, call.callId, epoch)) === 'already_claimed') {
      // Personne ne sait si l'effet de l'outil a eu lieu : il n'est jamais relancé.
      return apply({
        t: 'tool_result',
        callId: call.callId,
        output: text("État inconnu : l'exécution précédente s'est arrêtée sans résultat."),
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
   * Outils confiés à un client alors qu'aucun client n'est attaché : l'appel échoue à son
   * échéance. Rend l'échéance la plus proche de ceux qui attendent encore.
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
          output: text('Aucun client attaché n’a exécuté cet appel dans le délai.'),
          isError: true,
        })
      } else {
        next = Math.min(next ?? Infinity, deadline)
      }
    }
    return next
  }

  /** Ce que l'hôte doit savoir en plus quand le tour s'arrête. */
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
      // Le budget ne compte qu'après une intention, sinon un tour lent à charger ne ferait rien.
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
      // Seuls les outils en lecture seule s'exécutent ensemble ; les autres, un par un.
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

/** Exécute un tour sur une conversation. */
export const runTurn = (options: TurnOptions): Promise<TurnResult> => turn(options)
