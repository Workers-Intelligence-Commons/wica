// Synchronized browser collections. In the browser, each one follows the sync source of the
// build target (see `sync/`) and keeps its rows in the local cache; during server rendering, it
// reads its rows through the server's data contracts.

import { type CollectionConfig, collectionOptions, type DbClient } from '@tanstack/react-db'

import type {
  ChunkRow,
  ConversationRow,
  ItemShapeRow,
  ModelCallRow,
  ShapeTable,
} from '../shared/rows.ts'
import { type CacheFile, cacheName } from './cache.ts'
import { collectionSync } from './sync/index.ts'

/** Dependencies the browser `DbClient` receives: cache files already opened. */
export type BrowserDependencies = {
  /** The `name` file, opened before the render that needs it; `null` without cache. */
  cache: (name: string) => CacheFile | null
  account: string
}

/** Rows of a table for server rendering, provided by the hub server. */
export type ServerRows = (table: ShapeTable, conversationId?: string) => Promise<readonly unknown[]>

const SCHEMA_VERSION = 1
/** Wait for the sync before showing the local cache. */
const CACHE_RENDER_AFTER_MS = 1_500
/**
 * Delay after which a conversation that was left stops following its shapes. Each follow keeps a
 * connection open, and a browser opens only 6 of them per origin over HTTP/1.1: beyond that,
 * commands wait for one to free up.
 */
const CONVERSATION_GC_MS = 5_000

function synced<T extends Record<string, unknown>>(
  client: DbClient,
  id: string,
  table: ShapeTable,
  getKey: (row: T) => string,
  cacheFile: string | null,
  conversationId?: string,
) {
  if (import.meta.env.SSR) {
    const rows = client.requireDependency<ServerRows>('serverRows')
    return {
      id,
      getKey,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          void rows(table, conversationId).then((list) => {
            begin()
            for (const value of list) write({ type: 'insert', value: value as T })
            void commit()
            markReady()
          })
        },
      },
    } satisfies CollectionConfig<T, string>
  }
  const deps = client.requireDependency<BrowserDependencies>('browser')
  const source = collectionSync<T>({
    id,
    getKey,
    table,
    ...(conversationId ? { conversationId, gcTime: CONVERSATION_GC_MS } : {}),
  })
  const file = cacheFile ? deps.cache(cacheFile) : null
  if (!file) return source
  // Without an answer from the sync within this delay, the screen opens on the cached rows.
  return file.persisted({
    ...source,
    persistence: file.persistence,
    schemaVersion: SCHEMA_VERSION,
    initialRender: { strategy: 'network-first', networkTimeoutMs: CACHE_RENDER_AFTER_MS },
  })
}

const account = (client: DbClient) =>
  client.requireDependency<BrowserDependencies>('browser').account
const accountFile = (client: DbClient) => (import.meta.env.SSR ? null : cacheName(account(client)))
const conversationFile = (client: DbClient, conversationId: string) =>
  import.meta.env.SSR ? null : cacheName(account(client), conversationId)

export const conversationsCollection = collectionOptions('conversations', (client) =>
  synced<ConversationRow>(
    client,
    'conversations',
    'conversations',
    (r) => r.id,
    accountFile(client),
  ),
)

/** One descriptor per conversation, kept: each render finds the same object. */
const perConversation = <T>(make: (conversationId: string) => T) => {
  const made = new Map<string, T>()
  return (conversationId: string): T => {
    let descriptor = made.get(conversationId)
    if (!descriptor) {
      descriptor = make(conversationId)
      made.set(conversationId, descriptor)
    }
    return descriptor
  }
}

export const itemsCollection = perConversation((conversationId) =>
  collectionOptions(`items:${conversationId}`, (client) =>
    synced<ItemShapeRow>(
      client,
      `items:${conversationId}`,
      'items',
      (r) => r.id,
      conversationFile(client, conversationId),
      conversationId,
    ),
  ),
)

export const chunksCollection = perConversation((conversationId) =>
  collectionOptions(`chunks:${conversationId}`, (client) =>
    synced<ChunkRow>(
      client,
      `chunks:${conversationId}`,
      'item_chunks',
      (r) => `${r.item_id}:${r.idx}`,
      conversationFile(client, conversationId),
      conversationId,
    ),
  ),
)

export const callsCollection = perConversation((conversationId) =>
  collectionOptions(`calls:${conversationId}`, (client) =>
    synced<ModelCallRow>(
      client,
      `calls:${conversationId}`,
      'model_calls',
      (r) => r.id,
      conversationFile(client, conversationId),
      conversationId,
    ),
  ),
)
