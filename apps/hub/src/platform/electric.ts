// Rows of the pages through Electric, on Compose: the client never reaches Electric. The hub sets
// the table, the filter and the columns of each shape; from the client, it forwards only the sync
// protocol parameters (position, resume, live wait), and it adds the Electric secret.

import type { Platform, SyncScope, SyncTable } from '../server/app.ts'
import type { PgStorage } from '../server/config.ts'

export type ShapeSpec = { table: string; where: string; params: string[]; columns: string[] }

/**
 * Sync protocol parameters a client can set: those of the Electric client, without the subsets,
 * which the hub's shapes (full sync) do not use.
 */
const CLIENT_PARAMS = new Set([
  'live',
  'live_sse',
  'experimental_live_sse',
  'handle',
  'offset',
  'cursor',
  'expired_handle',
  'log',
  'cache-buster',
])

/**
 * The shape served for a request. `owner` is the account that reads; `conversationId` is
 * accepted only after the caller has checked access to it.
 */
export function shapeSpec(name: SyncTable, scope: SyncScope): ShapeSpec | null {
  switch (name) {
    case 'conversations':
      return {
        table: 'conversations',
        where: 'owner_id = $1',
        params: [scope.owner],
        columns: [
          'id',
          'owner_id',
          'organization_id',
          'parent_conversation_id',
          'parent_call_id',
          'title',
          'model',
          'head_item_id',
          'id_salt',
          'created_at',
          'updated_at',
        ],
      }
    case 'items':
      return scope.conversationId
        ? {
            table: 'items',
            where: 'conversation_id = $1',
            params: [scope.conversationId],
            columns: ['conversation_id', 'id', 'parent_id', 'seq', 'kind', 'payload', 'status'],
          }
        : null
    case 'model_calls':
      return scope.conversationId
        ? {
            table: 'model_calls',
            where: 'conversation_id = $1',
            params: [scope.conversationId],
            columns: [
              'conversation_id',
              'id',
              'item_ids',
              'model',
              'model_name',
              'started_at',
              'first_token_ms',
              'duration_ms',
              'input_tokens',
              'output_tokens',
              'cache_read_tokens',
              'cache_write_tokens',
              'reasoning',
            ],
          }
        : null
    case 'item_chunks':
      return scope.conversationId
        ? {
            table: 'item_chunks',
            where: 'conversation_id = $1',
            params: [scope.conversationId],
            columns: ['conversation_id', 'item_id', 'idx', 'text'],
          }
        : null
  }
}

/** Request to Electric: the server's shape, only the client's sync parameters. */
export function upstreamUrl(
  electricUrl: string,
  secret: string | undefined,
  spec: ShapeSpec,
  clientUrl: URL,
): URL {
  const url = new URL('/v1/shape', electricUrl)
  for (const [key, value] of clientUrl.searchParams) {
    if (CLIENT_PARAMS.has(key)) url.searchParams.set(key, value)
  }
  url.searchParams.set('table', spec.table)
  url.searchParams.set('where', spec.where)
  spec.params.forEach((value, i) => url.searchParams.set(`params[${i + 1}]`, value))
  url.searchParams.set('columns', spec.columns.join(','))
  if (secret) url.searchParams.set('secret', secret)
  return url
}

/**
 * Electric response returned to the client: without the compression headers, which `fetch` has
 * already undone, and with `Vary` so that no cache serves the shape of another session again.
 */
export function proxiedResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.set('vary', 'Cookie, Authorization')
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/** The `rows` hook of the platform, over the Electric service of the storage. */
export function electricRows(storage: PgStorage): NonNullable<Platform['rows']> {
  return async (req, table, scope) => {
    const spec = shapeSpec(table, scope)
    if (!spec) return failure(400, 'unknown shape')
    let upstream: Response
    try {
      upstream = await fetch(
        upstreamUrl(storage.electricUrl, storage.electricSecret, spec, new URL(req.url)),
        { signal: req.signal },
      )
    } catch {
      // A client that left closes its pending request: this is not a failure.
      if (req.signal.aborted) return new Response(null, { status: 499 })
      return failure(502, 'sync unavailable')
    }
    return proxiedResponse(upstream)
  }
}
