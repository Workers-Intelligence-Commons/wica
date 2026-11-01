// The rows of the component's conversation, as the hub syncs them: on Workers through the live
// socket of the conversation, opened with a short ticket since a browser socket carries no
// header; under Compose through the shapes of Electric, whose client is loaded only there.

import type { ChunkRow, ItemShapeRow } from '../shared/rows.ts'
import type { LiveFrame } from '../shared/live.ts'
import type { EmbedInfo } from '../shared/embed.ts'
import { type HubApi, HubError } from './api.ts'

export type Rows = { items: ItemShapeRow[]; chunks: ChunkRow[] }

/** Reports the rows after each change, or the error that ends the sync. */
export type Listener = { rows: (rows: Rows) => void; failed: (error: Error) => void }

const FIRST_RETRY_MS = 500
const MAX_RETRY_MS = 30_000

const chunkKey = (row: Pick<ChunkRow, 'item_id' | 'idx'>) => `${row.item_id}:${row.idx}`

/** Follows the conversation until the returned function stops it. */
export function follow(
  api: HubApi,
  sync: EmbedInfo['sync'],
  conversationId: string,
  listener: Listener,
): () => void {
  return sync === 'socket'
    ? followSocket(api, conversationId, listener)
    : followShapes(api, conversationId, listener)
}

function followSocket(api: HubApi, conversationId: string, listener: Listener) {
  const items = new Map<string, ItemShapeRow>()
  const chunks = new Map<string, ChunkRow>()
  let socket: WebSocket | null = null
  let stopped = false
  let retry = FIRST_RETRY_MS

  const report = () => listener.rows({ items: [...items.values()], chunks: [...chunks.values()] })

  function receive(frame: LiveFrame) {
    switch (frame.t) {
      case 'snapshot':
        items.clear()
        chunks.clear()
        for (const row of frame.items) items.set(row.id, row)
        for (const row of frame.chunks) chunks.set(chunkKey(row), row)
        break
      case 'items':
        for (const row of frame.rows) items.set(row.id, row)
        break
      case 'chunks':
        for (const row of frame.rows) chunks.set(chunkKey(row), row)
        break
      case 'chunks_cleared':
        for (const [key, row] of chunks) if (row.item_id === frame.itemId) chunks.delete(key)
        break
      default:
        return
    }
    report()
  }

  async function connect() {
    let ticket: string
    try {
      ticket = (await api.liveTicket(conversationId)).ticket
    } catch (error) {
      // The conversation or the key is gone: retrying cannot bring them back.
      if (error instanceof HubError && (error.status === 401 || error.status === 404)) {
        return listener.failed(error)
      }
      return later()
    }
    if (stopped) return
    const url = api.url(`/api/live/${encodeURIComponent(conversationId)}`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket)
    const opened = new WebSocket(url)
    socket = opened
    opened.onopen = () => (retry = FIRST_RETRY_MS)
    opened.onmessage = (event) => {
      if (socket === opened) receive(JSON.parse(String(event.data)) as LiveFrame)
    }
    opened.onclose = () => {
      if (socket !== opened) return
      socket = null
      later()
    }
  }

  function later() {
    if (stopped) return
    setTimeout(() => void connect(), retry)
    retry = Math.min(retry * 2, MAX_RETRY_MS)
  }

  void connect()
  return () => {
    stopped = true
    const open = socket
    socket = null
    open?.close()
  }
}

function followShapes(api: HubApi, conversationId: string, listener: Listener) {
  let items: ItemShapeRow[] = []
  let chunks: ChunkRow[] = []
  const stops: (() => void)[] = []
  let stopped = false
  const report = () => listener.rows({ items, chunks })

  void import('@electric-sql/client').then(({ Shape, ShapeStream }) => {
    if (stopped) return
    const shape = <T extends Record<string, unknown>>(table: string, set: (rows: T[]) => void) => {
      const stream = new ShapeStream<T>({
        url: api.url(`/api/shapes/${table}`).href,
        params: { conversation: conversationId },
        headers: api.headers(),
        fetchClient: ((input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, credentials: 'omit' })) as typeof fetch,
        onError: (error) => {
          listener.failed(error instanceof Error ? error : new Error(String(error)))
        },
      })
      // The client's own types disagree under `exactOptionalPropertyTypes`.
      const unsubscribe = new Shape<T>(stream as never).subscribe(({ rows }) => {
        set(rows)
        report()
      })
      stops.push(() => {
        unsubscribe()
        stream.unsubscribeAll()
      })
    }
    shape<ItemShapeRow>('items', (rows) => (items = rows))
    shape<ChunkRow>('item_chunks', (rows) => (chunks = rows))
  }, listener.failed)

  return () => {
    stopped = true
    for (const stop of stops) stop()
  }
}
