// Collections synchronisées du navigateur. Dans le navigateur, chacune suit une shape Electric
// servie par le proxy de l'application et garde ses lignes dans le cache local ; pendant le rendu
// serveur, elle lit ses lignes dans Postgres, sans Electric.

import { type CollectionConfig, collectionOptions, type DbClient } from '@tanstack/react-db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'

import type { ChunkRow, ItemRow } from '../shared/rows.ts'
import { type CachePersistence, cacheName } from './cache.ts'

export type ConversationRow = {
  id: string
  owner_id: string
  organization_id: string | null
  server_id: string | null
  parent_conversation_id: string | null
  parent_call_id: string | null
  title: string
  model: string | null
  head_item_id: string | null
  id_salt: string
  created_at: string
  updated_at: string
}

export type ServerRow = {
  id: string
  owner_id: string
  name: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export type ItemShapeRow = Omit<ItemRow, 'blob_sha256'>

/** Dépendances que le `DbClient` du navigateur reçoit : fichiers du cache déjà ouverts. */
export type BrowserDependencies = {
  /** Persistance du fichier `name`, ouverte avant le rendu qui en a besoin ; `null` sans cache. */
  cache: (name: string) => CachePersistence | null
  account: string
}

export type ShapeTable = 'conversations' | 'servers' | 'items' | 'item_chunks'

/** Lignes d'une table pour le rendu serveur, fournies par le serveur du chat. */
export type ServerRows = (table: ShapeTable, conversationId?: string) => Promise<readonly unknown[]>

const SCHEMA_VERSION = 1
/** Attente de la synchro avant d'afficher le cache local. */
const CACHE_RENDER_AFTER_MS = 1_500
/**
 * Délai après lequel une conversation quittée cesse de suivre ses shapes. Chaque suivi garde une
 * connexion ouverte, et un navigateur n'en ouvre que 6 par origine en HTTP/1.1 : au-delà, les
 * commandes attendent qu'une se libère.
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
  const electric = electricCollectionOptions<T>({
    id,
    getKey,
    ...(conversationId ? { gcTime: CONVERSATION_GC_MS } : {}),
    shapeOptions: {
      url: new URL(`/api/shapes/${table}`, location.origin).toString(),
      ...(conversationId ? { params: { conversation: conversationId } } : {}),
    },
  })
  const persistence = cacheFile ? deps.cache(cacheFile) : null
  if (!persistence) return electric
  // Sans réponse de la synchro dans ce délai, l'écran s'ouvre sur les lignes du cache.
  return persistedCollectionOptions({
    ...electric,
    persistence,
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

export const serversCollection = collectionOptions('servers', (client) =>
  synced<ServerRow>(client, 'servers', 'servers', (r) => r.id, accountFile(client)),
)

/** Un descripteur par conversation, gardé : chaque rendu retrouve le même objet. */
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
