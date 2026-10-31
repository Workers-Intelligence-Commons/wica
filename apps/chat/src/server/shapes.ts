// Proxy des shapes : le client n'atteint jamais Electric. L'application fixe la table, le filtre
// et les colonnes de chaque shape ; du client, elle ne transmet que les paramètres du protocole
// de synchro (position, reprise, attente en direct), et elle ajoute le secret d'Electric.

export type ShapeName = 'conversations' | 'items' | 'item_chunks' | 'servers' | 'commands'

export type ShapeSpec = { table: string; where: string; params: string[]; columns: string[] }

/**
 * Paramètres du protocole de synchro qu'un client peut fixer : ceux du client Electric, sans les
 * sous-ensembles, que les shapes du chat (synchro complète) n'utilisent pas.
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
 * La shape servie pour une demande. `owner` est le compte qui lit ; `conversationId` n'est
 * accepté qu'après la vérification de son accès par l'appelant.
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

/** Requête vers Electric : la shape du serveur, les seuls paramètres de synchro du client. */
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
 * Réponse d'Electric rendue au client : sans les en-têtes de compression, que `fetch` a déjà
 * défaite, et avec `Vary` pour qu'aucun cache ne resserve la shape d'une autre session.
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
