// Browser sync on Workers. The rows of an open conversation come from one socket to its Durable
// Object, shared by the collections of that conversation; the list of conversations is read
// again every 30 s and after the tab's own actions, with the heads the open sockets report.

import type { ChunkRow, ConversationRow, ItemShapeRow, ModelCallRow } from '../../shared/rows.ts'
import { type LiveFrame, livePath } from '../../shared/live.ts'
import { apiFetch, guestKey } from '../guest.ts'

export const LIST_REFRESH_MS = 30_000
const FIRST_RETRY_MS = 200
const MAX_RETRY_MS = 30_000

type Change<T> = { type: 'insert' | 'update'; value: T } | { type: 'delete'; key: string }
/** What a collection applies: every row, or changes to the rows it holds. */
export type RowBatch<T> = { snapshot: T[] } | { changes: Change<T>[] }

const chunkKey = (row: Pick<ChunkRow, 'item_id' | 'idx'>) => `${row.item_id}:${row.idx}`

type Listener =
  | { items: (batch: RowBatch<ItemShapeRow>) => void }
  | { chunks: (batch: RowBatch<ChunkRow>) => void }
  | { calls: (batch: RowBatch<ModelCallRow>) => void }

/** Socket of one conversation, with the rows it delivered; it reconnects until released. */
class LiveConversation {
  readonly items = new Map<string, ItemShapeRow>()
  readonly chunks = new Map<string, ChunkRow>()
  readonly calls = new Map<string, ModelCallRow>()
  head: string | null = null
  #ready = false
  #users = 0
  #socket: WebSocket | null = null
  #retry = FIRST_RETRY_MS
  #listeners = new Set<Listener>()
  #waiters = new Map<string, Set<() => void>>()

  readonly conversationId: string

  constructor(conversationId: string) {
    this.conversationId = conversationId
  }

  acquire() {
    this.#users += 1
    if (!this.#socket) this.#open()
  }

  /** True when nobody uses the conversation anymore. */
  release() {
    this.#users -= 1
    if (this.#users > 0) return false
    const socket = this.#socket
    this.#socket = null
    socket?.close()
    return true
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener)
    // A collection that arrives after the snapshot starts from the rows already delivered.
    if (this.#ready) this.#deliver(listener)
    return () => void this.#listeners.delete(listener)
  }

  /** Resolves once the sync delivered the item `id`, or with false after `timeoutMs`. */
  awaitItem(id: string, timeoutMs: number) {
    if (this.items.has(id)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const waiters = this.#waiters.get(id) ?? new Set()
      this.#waiters.set(id, waiters)
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        waiters.delete(done)
        resolve(false)
      }, timeoutMs)
      waiters.add(done)
    })
  }

  #open() {
    void this.#connect()
  }

  async #connect() {
    const url = new URL(livePath(this.conversationId), location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    // A browser socket carries no header: a guest opens it with a short ticket.
    if (guestKey()) {
      const response = await apiFetch(
        `/api/live-ticket/${encodeURIComponent(this.conversationId)}`,
        { method: 'POST' },
      ).catch(() => null)
      if (response?.ok) {
        url.searchParams.set('ticket', ((await response.json()) as { ticket: string }).ticket)
      }
      if (this.#socket || this.#users === 0) return
    }
    const socket = new WebSocket(url)
    this.#socket = socket
    socket.onopen = () => (this.#retry = FIRST_RETRY_MS)
    socket.onmessage = (event) => {
      if (this.#socket === socket) this.#receive(JSON.parse(String(event.data)) as LiveFrame)
    }
    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#socket = null
      setTimeout(() => {
        if (this.#users > 0 && !this.#socket) this.#open()
      }, this.#retry)
      this.#retry = Math.min(this.#retry * 2, MAX_RETRY_MS)
    }
  }

  #receive(frame: LiveFrame) {
    const itemChanges: Change<ItemShapeRow>[] = []
    const chunkChanges: Change<ChunkRow>[] = []
    const callChanges: Change<ModelCallRow>[] = []
    switch (frame.t) {
      case 'snapshot':
        this.items.clear()
        this.chunks.clear()
        this.calls.clear()
        for (const row of frame.items) this.items.set(row.id, row)
        for (const row of frame.chunks) this.chunks.set(chunkKey(row), row)
        for (const row of frame.calls) this.calls.set(row.id, row)
        this.#ready = true
        this.#setHead(frame.head)
        for (const listener of this.#listeners) this.#deliver(listener)
        for (const row of frame.items) this.#confirm(row.id)
        return
      case 'items':
        for (const row of frame.rows) {
          itemChanges.push({ type: this.items.has(row.id) ? 'update' : 'insert', value: row })
          this.items.set(row.id, row)
        }
        break
      case 'chunks':
        for (const row of frame.rows) {
          const key = chunkKey(row)
          chunkChanges.push({ type: this.chunks.has(key) ? 'update' : 'insert', value: row })
          this.chunks.set(key, row)
        }
        break
      case 'chunks_cleared':
        for (const [key, row] of this.chunks) {
          if (row.item_id !== frame.itemId) continue
          chunkChanges.push({ type: 'delete', key })
          this.chunks.delete(key)
        }
        break
      case 'calls':
        for (const row of frame.rows) {
          callChanges.push({ type: this.calls.has(row.id) ? 'update' : 'insert', value: row })
          this.calls.set(row.id, row)
        }
        break
      case 'head':
        this.#setHead(frame.head)
        return
    }
    for (const listener of this.#listeners) {
      if ('items' in listener && itemChanges.length > 0) listener.items({ changes: itemChanges })
      if ('chunks' in listener && chunkChanges.length > 0)
        listener.chunks({ changes: chunkChanges })
      if ('calls' in listener && callChanges.length > 0) listener.calls({ changes: callChanges })
    }
    if (frame.t === 'items') for (const row of frame.rows) this.#confirm(row.id)
  }

  #deliver(listener: Listener) {
    if ('items' in listener) listener.items({ snapshot: [...this.items.values()] })
    else if ('chunks' in listener) listener.chunks({ snapshot: [...this.chunks.values()] })
    else listener.calls({ snapshot: [...this.calls.values()] })
  }

  #confirm(id: string) {
    const waiters = this.#waiters.get(id)
    if (!waiters) return
    this.#waiters.delete(id)
    for (const done of waiters) done()
  }

  #setHead(head: string | null) {
    this.head = head
    if (head) list.applyHead(this.conversationId, head)
  }
}

const conversations = new Map<string, LiveConversation>()

function acquire(conversationId: string) {
  let live = conversations.get(conversationId)
  if (!live) {
    live = new LiveConversation(conversationId)
    conversations.set(conversationId, live)
  }
  live.acquire()
  return live
}

function release(live: LiveConversation) {
  if (live.release()) conversations.delete(live.conversationId)
}

/** Follows the items of a conversation through its socket. */
export function followItems(
  conversationId: string,
  apply: (batch: RowBatch<ItemShapeRow>) => void,
) {
  const live = acquire(conversationId)
  const unsubscribe = live.subscribe({ items: apply })
  return () => {
    unsubscribe()
    release(live)
  }
}

/** Follows the text batches of a conversation through its socket. */
export function followChunks(conversationId: string, apply: (batch: RowBatch<ChunkRow>) => void) {
  const live = acquire(conversationId)
  const unsubscribe = live.subscribe({ chunks: apply })
  return () => {
    unsubscribe()
    release(live)
  }
}

/** Follows the completed model calls of a conversation through its socket. */
export function followCalls(
  conversationId: string,
  apply: (batch: RowBatch<ModelCallRow>) => void,
) {
  const live = acquire(conversationId)
  const unsubscribe = live.subscribe({ calls: apply })
  return () => {
    unsubscribe()
    release(live)
  }
}

/** Waits for the item `id` written by the server, holding the conversation's socket meanwhile. */
export function rowConfirmation(conversationId: string) {
  return async (id: string, timeoutMs: number) => {
    const live = acquire(conversationId)
    try {
      return await live.awaitItem(id, timeoutMs)
    } finally {
      release(live)
    }
  }
}

/**
 * The list of conversations: read from the server, with the head of each open conversation
 * taken from its socket, which is ahead of the list.
 */
const list = {
  rows: new Map<string, ConversationRow>(),
  apply: null as ((batch: RowBatch<ConversationRow>) => void) | null,
  load: null as (() => Promise<void>) | null,
  waiters: new Map<string, Set<() => void>>(),

  withLiveHead(row: ConversationRow): ConversationRow {
    const head = conversations.get(row.id)?.head
    return head ? { ...row, head_item_id: head } : row
  },

  replace(rows: ConversationRow[]) {
    this.rows = new Map(rows.map((row) => [row.id, this.withLiveHead(row)]))
    this.apply?.({ snapshot: [...this.rows.values()] })
    for (const id of this.rows.keys()) {
      const waiters = this.waiters.get(id)
      this.waiters.delete(id)
      for (const done of waiters ?? []) done()
    }
  },

  applyHead(conversationId: string, head: string) {
    const row = this.rows.get(conversationId)
    if (!row || row.head_item_id === head) return
    const next = { ...row, head_item_id: head }
    this.rows.set(conversationId, next)
    this.apply?.({ changes: [{ type: 'update', value: next }] })
  },
}

async function fetchList(): Promise<ConversationRow[]> {
  const response = await apiFetch('/api/conversations', {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`conversation list unavailable (${response.status})`)
  return (await response.json()) as ConversationRow[]
}

/** Follows the list of conversations: one read now, then every `LIST_REFRESH_MS`. */
export function followList(
  apply: (batch: RowBatch<ConversationRow>) => void,
  onError: (error: unknown) => void,
) {
  let stopped = false
  const load = async () => {
    try {
      const rows = await fetchList()
      if (!stopped) list.replace(rows)
    } catch (error) {
      if (!stopped) onError(error)
    }
  }
  list.apply = apply
  list.load = load
  void load()
  const timer = setInterval(() => void load(), LIST_REFRESH_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    if (list.apply === apply) {
      list.apply = null
      list.load = null
    }
  }
}

/** Reads the list again now, after an action of this tab. */
export function refreshList() {
  void list.load?.()
}

/** Reads the list again until it holds the new conversation, or until `timeoutMs`. */
export async function awaitCreated(
  _collection: unknown,
  created: { id: string },
  timeoutMs: number,
) {
  if (list.rows.has(created.id)) return
  const seen = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    const waiters = list.waiters.get(created.id) ?? new Set()
    list.waiters.set(created.id, waiters)
    waiters.add(() => {
      clearTimeout(timer)
      resolve()
    })
  })
  await list.load?.()
  await seen
}
