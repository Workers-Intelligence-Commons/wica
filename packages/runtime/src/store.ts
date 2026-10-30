// Interface de persistance du journal (specs/harness.md, Exécution sans état et sessions)
// et sa version en mémoire, qui sert aux tests et au serveur sans persistance.

import type { Item, ItemDraft } from '@wica/core'

export type Appended = {
  persisted: { id: string; seq: number }[]
  interruptRequested: boolean
}

/**
 * Instantané de l'état, dérivé du journal et jetable : les éléments jusqu'à `seq`, tous réglés,
 * pour qu'un tour ne relise que la suite. Aucun élément d'un instantané ne change plus ensuite.
 */
export type Snapshot = { schema: 1; seq: number; items: Item[] }

/** Résultat d'une réclamation : un `epoch`, ou la conversation tenue par un tour vivant. */
export type Claim = { epoch: number } | { busyForMs: number }

export interface Store {
  /**
   * Réclame la conversation pour un bail de `leaseMs` : rend un `epoch` croissant qui périme les
   * tours précédents. Tant qu'un autre tour tient un bail en cours, rend le temps qui lui reste.
   */
  claim(conversationId: string, leaseMs: number): Promise<Claim>
  /** Prolonge le bail ; refuse un `epoch` périmé. Chaque écriture le prolonge aussi. */
  renew(conversationId: string, epoch: number): Promise<void>
  /** Libère le bail à la fin du tour, pour que le suivant n'attende pas son échéance. */
  release(conversationId: string, epoch: number): Promise<void>
  load(
    conversationId: string,
    fromSeq: number,
  ): Promise<{ salt: string; head: string | null; items: Item[]; interruptRequested: boolean }>
  /** Ajoute des éléments ; un identifiant déjà présent est accusé sans être dupliqué. */
  append(conversationId: string, items: ItemDraft[], epoch: number): Promise<Appended>
  appendBatch(
    conversationId: string,
    itemId: string,
    idx: number,
    text: string,
    epoch: number,
  ): Promise<{ interruptRequested: boolean }>
  /** Écrit le contenu final et le `status` d'un élément produit en flux, et supprime ses lots. */
  settle(conversationId: string, final: ItemDraft, epoch: number): Promise<void>
  setHead(conversationId: string, itemId: string, epoch: number): Promise<void>
  requestInterrupt(conversationId: string): Promise<void>
  /** Efface la demande d'interruption une fois traitée par le tour qui tient la conversation. */
  clearInterrupt(conversationId: string, epoch: number): Promise<void>
  /** Réclame l'exécution d'un outil ; idempotent pour un même `epoch`, refusé pour un autre. */
  claimToolCall(
    conversationId: string,
    callId: string,
    epoch: number,
  ): Promise<'claimed' | 'already_claimed'>
  loadSnapshot(conversationId: string): Promise<Snapshot | undefined>
  saveSnapshot(conversationId: string, snapshot: Snapshot, epoch: number): Promise<void>
}

export class StaleEpochError extends Error {
  override name = 'StaleEpochError'
}

type Conversation = {
  salt: string
  epoch: number
  lease: { until: number; ms: number } | null
  snapshot?: Snapshot
  head: string | null
  items: Item[]
  batches: Map<string, Map<number, string>>
  /** Réclamations d'outils : `callId` vers l'`epoch` qui l'a réclamé. */
  toolClaims: Map<string, number>
  interruptRequested: boolean
}

export class MemoryStore implements Store {
  readonly #conversations = new Map<string, Conversation>()
  readonly #salt: (conversationId: string) => string
  readonly #now: () => number

  constructor(options: { salt?: (conversationId: string) => string; now?: () => number } = {}) {
    this.#salt = options.salt ?? (() => crypto.randomUUID())
    this.#now = options.now ?? Date.now
  }

  #get(conversationId: string): Conversation {
    let c = this.#conversations.get(conversationId)
    if (!c) {
      c = {
        salt: this.#salt(conversationId),
        epoch: 0,
        lease: null,
        head: null,
        items: [],
        batches: new Map(),
        toolClaims: new Map(),
        interruptRequested: false,
      }
      this.#conversations.set(conversationId, c)
    }
    return c
  }

  #fenced(conversationId: string, epoch: number): Conversation {
    const c = this.#get(conversationId)
    if (epoch !== c.epoch) throw new StaleEpochError(`epoch ${epoch} périmé (${c.epoch})`)
    if (c.lease) c.lease.until = this.#now() + c.lease.ms
    return c
  }

  async claim(conversationId: string, leaseMs: number): Promise<Claim> {
    const c = this.#get(conversationId)
    const left = c.lease ? c.lease.until - this.#now() : 0
    if (left > 0) return { busyForMs: left }
    c.epoch += 1
    c.lease = { until: this.#now() + leaseMs, ms: leaseMs }
    return { epoch: c.epoch }
  }

  async renew(conversationId: string, epoch: number) {
    this.#fenced(conversationId, epoch)
  }

  async release(conversationId: string, epoch: number) {
    const c = this.#get(conversationId)
    if (epoch === c.epoch) c.lease = null
  }

  async loadSnapshot(conversationId: string) {
    return structuredClone(this.#get(conversationId).snapshot)
  }

  async saveSnapshot(conversationId: string, snapshot: Snapshot, epoch: number) {
    this.#fenced(conversationId, epoch).snapshot = structuredClone(snapshot)
  }

  async load(conversationId: string, fromSeq: number) {
    const c = this.#get(conversationId)
    return {
      salt: c.salt,
      head: c.head,
      items: structuredClone(c.items.filter((i) => i.seq > fromSeq)),
      interruptRequested: c.interruptRequested,
    }
  }

  async append(conversationId: string, items: ItemDraft[], epoch: number) {
    const c = this.#fenced(conversationId, epoch)
    const persisted = items.map((draft) => {
      const existing = c.items.find((i) => i.id === draft.id)
      if (existing) return { id: existing.id, seq: existing.seq }
      const seq = (c.items[c.items.length - 1]?.seq ?? 0) + 1
      c.items.push({ ...structuredClone(draft), seq } as Item)
      return { id: draft.id, seq }
    })
    const last = items[items.length - 1]
    if (last) c.head = last.id
    return { persisted, interruptRequested: c.interruptRequested }
  }

  async appendBatch(
    conversationId: string,
    itemId: string,
    idx: number,
    text: string,
    epoch: number,
  ) {
    const c = this.#fenced(conversationId, epoch)
    const batches = c.batches.get(itemId) ?? new Map<number, string>()
    batches.set(idx, text)
    c.batches.set(itemId, batches)
    return { interruptRequested: c.interruptRequested }
  }

  async settle(conversationId: string, final: ItemDraft, epoch: number) {
    const c = this.#fenced(conversationId, epoch)
    const index = c.items.findIndex((i) => i.id === final.id)
    const current = c.items[index]
    if (!current) throw new Error(`élément inconnu : ${final.id}`)
    c.items[index] = { ...structuredClone(final), seq: current.seq } as Item
    c.batches.delete(final.id)
  }

  async setHead(conversationId: string, itemId: string, epoch: number) {
    this.#fenced(conversationId, epoch).head = itemId
  }

  async requestInterrupt(conversationId: string) {
    this.#get(conversationId).interruptRequested = true
  }

  async clearInterrupt(conversationId: string, epoch: number) {
    this.#fenced(conversationId, epoch).interruptRequested = false
  }

  async claimToolCall(conversationId: string, callId: string, epoch: number) {
    const c = this.#fenced(conversationId, epoch)
    // Rejouée par le même tour (réponse perdue), la réclamation reste la sienne.
    const owner = c.toolClaims.get(callId)
    if (owner !== undefined && owner !== epoch) return 'already_claimed' as const
    c.toolClaims.set(callId, epoch)
    return 'claimed' as const
  }
}

export type ResilientOptions = {
  /** Erreur passagère (réseau coupé, service indisponible) ; par défaut les erreurs réseau de `fetch`. */
  isTransient?: (error: unknown) => boolean
  /** Première attente avant un nouvel essai ; elle double à chaque échec. 200 ms par défaut. */
  baseDelayMs?: number
  /** Attente maximale entre deux essais. 30 s par défaut. */
  maxDelayMs?: number
  /** Arrête les essais, par exemple à l'arrêt du serveur. */
  signal?: AbortSignal
}

const networkError = (error: unknown) =>
  error instanceof TypeError || (error as { retryable?: unknown } | null)?.retryable === true

/**
 * `Store` distant qui réessaie ses opérations pendant une coupure, sans limite de durée (machine
 * endormie, réseau perdu) : un outil en cours se termine et son résultat est écrit à la
 * reconnexion. Les écritures sont rejouables : clé primaire, lot par index, réclamation d'outil
 * idempotente pour un même `epoch`. Une réclamation de conversation rejouée peut au pire trouver
 * son propre bail et attendre son échéance.
 */
export function resilientStore(store: Store, options: ResilientOptions = {}): Store {
  const transient = options.isTransient ?? networkError
  const base = options.baseDelayMs ?? 200
  const max = options.maxDelayMs ?? 30_000
  const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let failures = 0; ; failures++) {
      try {
        return await operation()
      } catch (error) {
        if (!transient(error) || options.signal?.aborted) throw error
        await new Promise((resolve) => setTimeout(resolve, Math.min(base * 2 ** failures, max)))
      }
    }
  }
  return {
    claim: (...a) => retry(() => store.claim(...a)),
    renew: (...a) => retry(() => store.renew(...a)),
    release: (...a) => retry(() => store.release(...a)),
    load: (...a) => retry(() => store.load(...a)),
    append: (...a) => retry(() => store.append(...a)),
    appendBatch: (...a) => retry(() => store.appendBatch(...a)),
    settle: (...a) => retry(() => store.settle(...a)),
    setHead: (...a) => retry(() => store.setHead(...a)),
    requestInterrupt: (...a) => retry(() => store.requestInterrupt(...a)),
    clearInterrupt: (...a) => retry(() => store.clearInterrupt(...a)),
    claimToolCall: (...a) => retry(() => store.claimToolCall(...a)),
    loadSnapshot: (...a) => retry(() => store.loadSnapshot(...a)),
    saveSnapshot: (...a) => retry(() => store.saveSnapshot(...a)),
  }
}
