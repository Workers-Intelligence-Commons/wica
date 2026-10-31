// Local browser cache: Postgres is the source of truth, so the cache is disposable, except for
// optimistic writes not yet confirmed. It holds one SQLite file for the conversation list and
// one per open conversation, in the OPFS, evicted by oldest opening beyond a quota. It keeps
// only one account at a time: it is cleared on logout and when another account logs in in the
// browser.

import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from '@tanstack/browser-db-sqlite-persistence'

export const CACHE_QUOTA = 40

const PREFIX = 'wica-cache'
const FILE_PREFIX = 'wica-'
const ACCOUNT_KEY = `${PREFIX}-account`

/**
 * File name for an account: `conversation` is absent for the conversation list. The wa-sqlite VFS
 * refuses a path longer than 64 characters, `-journal` suffix included: the name carries only one
 * identifier.
 */
export const cacheName = (account: string, conversation?: string) =>
  conversation ? `${FILE_PREFIX}c-${conversation}` : `${FILE_PREFIX}a-${account}`

/** Conversations to evict: the oldest opened beyond the quota, never a pending one. */
export function evictionPlan(
  opened: Record<string, number>,
  pending: ReadonlySet<string>,
  quota = CACHE_QUOTA,
): string[] {
  const byAge = Object.entries(opened).sort((a, b) => b[1] - a[1])
  return byAge
    .slice(quota)
    .map(([id]) => id)
    .filter((id) => !pending.has(id))
}

const registryKey = (account: string) => `${PREFIX}-opened-${account}`
const pendingKey = (account: string) => `${PREFIX}-pending-${account}`

const readJson = <T>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? '') as T) ?? fallback
  } catch {
    return fallback
  }
}

/** Conversations that carry an optimistic send not yet confirmed. */
export function markPending(account: string, conversation: string, pending: boolean) {
  const set = new Set(readJson<string[]>(pendingKey(account), []))
  if (pending) set.add(conversation)
  else set.delete(conversation)
  localStorage.setItem(pendingKey(account), JSON.stringify([...set]))
}

async function removeFile(name: string) {
  const root = await navigator.storage.getDirectory()
  for (const entry of [name, `${name}-journal`, `${name}-wal`]) {
    await root.removeEntry(entry, { recursive: true }).catch(() => {})
  }
}

export type CachePersistence = ReturnType<typeof createBrowserWASQLitePersistence>

const opened = new Map<string, Promise<CachePersistence | null>>()

/**
 * Persistence of a cache file, opened once per page. Without OPFS, or if the file does not open,
 * the cache is in memory only: the sync is enough.
 */
export function openCache(name: string): Promise<CachePersistence | null> {
  let persistence = opened.get(name)
  if (!persistence) {
    persistence = (async () => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
      try {
        const database = await openBrowserWASQLiteOPFSDatabase({
          databaseName: name,
          timeoutMs: 5_000,
        })
        const coordinator = new BrowserCollectionCoordinator({ dbName: name })
        return createBrowserWASQLitePersistence({ database, coordinator })
      } catch (error) {
        console.warn(`local cache unavailable for ${name}:`, error)
        return null
      }
    })()
    opened.set(name, persistence)
  }
  return persistence
}

/** Records the opening of a conversation, then evicts whatever exceeds the quota. */
export async function touchConversation(account: string, conversation: string, now = Date.now()) {
  const registry = readJson<Record<string, number>>(registryKey(account), {})
  registry[conversation] = now
  const pending = new Set(readJson<string[]>(pendingKey(account), []))
  const evicted = evictionPlan(registry, pending)
  for (const id of evicted) {
    delete registry[id]
    if (!opened.has(cacheName(account, id))) await removeFile(cacheName(account, id))
  }
  localStorage.setItem(registryKey(account), JSON.stringify(registry))
}

/** Clears the whole cache: every chat file in the OPFS, then the registries. */
export async function clearCache() {
  if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory()
    const names: string[] = []
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith(FILE_PREFIX)) names.push(name)
    }
    for (const name of names) await root.removeEntry(name, { recursive: true }).catch(() => {})
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(PREFIX)) localStorage.removeItem(key)
  }
}

/**
 * Cache of the logged-in account: the cache of another account, or of a logged-out account
 * (`cleared`), is cleared before any read.
 */
export async function claimCache(account: string, cleared: boolean) {
  const previous = localStorage.getItem(ACCOUNT_KEY)
  if (cleared || (previous !== null && previous !== account)) await clearCache()
  localStorage.setItem(ACCOUNT_KEY, account)
}
