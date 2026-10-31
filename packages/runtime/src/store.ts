// Persistence interface of the journal and its in-memory version, which serves the tests and the
// server without persistence.

import type { Item, ItemDraft } from '@wica/core'

export type Appended = {
  persisted: { id: string; seq: number }[]
  interruptRequested: boolean
}

/**
 * Snapshot of the state, derived from the journal and disposable: the items up to `seq`, all
 * settled, so that a turn reads only what follows. No item of a snapshot changes afterwards.
 */
export type Snapshot = { schema: 1; seq: number; items: Item[] }

/** Result of a claim: an `epoch`, or the conversation held by a live turn. */
export type Claim = { epoch: number } | { busyForMs: number }

export interface Store {
  /**
   * Claims the conversation for a lease of `leaseMs`: returns an increasing `epoch` that makes the
   * previous turns stale. While another turn holds a current lease, returns the time it has left.
   */
  claim(conversationId: string, leaseMs: number): Promise<Claim>
  /** Extends the lease; refuses a stale `epoch`. Each write extends it too. */
  renew(conversationId: string, epoch: number): Promise<void>
  /** Releases the lease at the end of the turn, so that the next one does not wait for it to expire. */
  release(conversationId: string, epoch: number): Promise<void>
  /**
   * Items after `fromSeq`. An item still in `streaming` carries the text of its batches, joined
   * back in the order of their `idx`: the turn that takes it over after a stop settles it with
   * this text.
   */
  load(
    conversationId: string,
    fromSeq: number,
  ): Promise<{ salt: string; head: string | null; items: Item[]; interruptRequested: boolean }>
  /** Adds items; an identifier already present is acknowledged without being duplicated. */
  append(conversationId: string, items: ItemDraft[], epoch: number): Promise<Appended>
  appendBatch(
    conversationId: string,
    itemId: string,
    idx: number,
    text: string,
    epoch: number,
  ): Promise<{ interruptRequested: boolean }>
  /** Writes the final content and the `status` of an item produced by streaming, and deletes its batches. */
  settle(conversationId: string, final: ItemDraft, epoch: number): Promise<void>
  setHead(conversationId: string, itemId: string, epoch: number): Promise<void>
  requestInterrupt(conversationId: string): Promise<void>
  /** Clears the interruption request once processed by the turn that holds the conversation. */
  clearInterrupt(conversationId: string, epoch: number): Promise<void>
  /** Claims the run of a tool; idempotent for the same `epoch`, refused for another one. */
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
  /** Tool claims: `callId` to the `epoch` that claimed it. */
  toolClaims: Map<string, number>
  interruptRequested: boolean
}

/** Copy of an item; in `streaming`, its text is the one of its batches in the order of `idx`. */
function withBatches(item: Item, batches: Map<number, string> | undefined): Item {
  const copy = structuredClone(item)
  if (copy.status !== 'streaming' || !batches) return copy
  if (copy.kind !== 'assistant_text' && copy.kind !== 'reasoning') return copy
  const text = [...batches]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .join('')
  return { ...copy, text }
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
    if (epoch !== c.epoch) throw new StaleEpochError(`epoch ${epoch} is stale (${c.epoch})`)
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
      items: c.items.filter((i) => i.seq > fromSeq).map((i) => withBatches(i, c.batches.get(i.id))),
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
    if (!current) throw new Error(`unknown item: ${final.id}`)
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
    // Replayed by the same turn (lost response), the claim stays its own.
    const owner = c.toolClaims.get(callId)
    if (owner !== undefined && owner !== epoch) return 'already_claimed' as const
    c.toolClaims.set(callId, epoch)
    return 'claimed' as const
  }
}

export type ResilientOptions = {
  /** Transient error (network down, service unavailable); by default the network errors of `fetch`. */
  isTransient?: (error: unknown) => boolean
  /** First wait before a new attempt; it doubles at each failure. 200 ms by default. */
  baseDelayMs?: number
  /** Maximum wait between two attempts. 30 s by default. */
  maxDelayMs?: number
  /** Stops the attempts, for example when the server stops. */
  signal?: AbortSignal
}

const networkError = (error: unknown) =>
  error instanceof TypeError || (error as { retryable?: unknown } | null)?.retryable === true

/**
 * Remote `Store` that retries its operations during a disconnection, with no time limit (machine
 * asleep, network lost): a running tool finishes and its result is written at reconnection. The
 * writes can be replayed: primary key, batch by index, tool claim idempotent for the same
 * `epoch`. A replayed conversation claim can at worst find its own lease and wait for it to
 * expire.
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
