// Shape proxy: the client never reaches Electric. The application sets the table, the filter and
// the columns of each shape; from the client, it forwards only the sync protocol parameters
// (position, resume, live wait), and it adds the Electric secret.

export type ShapeName = 'conversations' | 'items' | 'item_chunks' | 'servers' | 'commands'

export type ShapeSpec = { table: string; where: string; params: string[]; columns: string[] }

/**
 * Sync protocol parameters a client can set: those of the Electric client, without the subsets,
 * which the chat shapes (full sync) do not use.
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
export function shapeSpec(
  name: ShapeName,
  scope: { owner: string; conversationId?: string; serverId?: string },
): ShapeSpec | null {
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
          'server_id',
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
    case 'item_chunks':
      return scope.conversationId
        ? {
            table: 'item_chunks',
            where: 'conversation_id = $1',
            params: [scope.conversationId],
            columns: ['conversation_id', 'item_id', 'idx', 'text'],
          }
        : null
    case 'servers':
      return {
        table: 'servers',
        where: 'owner_id = $1',
        params: [scope.owner],
        columns: ['id', 'owner_id', 'name', 'created_at', 'last_seen_at', 'revoked_at'],
      }
    case 'commands':
      return scope.serverId
        ? {
            table: 'commands',
            where: 'server_id = $1 AND acked_at IS NULL',
            params: [scope.serverId],
            columns: ['id', 'conversation_id', 'payload', 'created_at'],
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
