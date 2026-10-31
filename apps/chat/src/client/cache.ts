// Cache local du navigateur : Postgres fait foi, donc le cache est jetable, sauf les écritures
// optimistes pas encore confirmées. Il tient un fichier SQLite pour la liste des conversations et
// un par conversation ouverte, dans l'OPFS, évincés par ancienneté d'ouverture au-delà d'un
// quota. Il ne garde qu'un compte à la fois : il est vidé à la déconnexion et quand un autre
// compte se connecte dans le navigateur.

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
 * Nom du fichier d'un compte : `conversation` absent pour la liste des conversations. Le VFS de
 * wa-sqlite refuse un chemin de plus de 64 caractères, suffixe `-journal` compris : le nom ne
 * porte qu'un identifiant.
 */
export const cacheName = (account: string, conversation?: string) =>
  conversation ? `${FILE_PREFIX}c-${conversation}` : `${FILE_PREFIX}a-${account}`

/** Conversations à évincer : les plus anciennement ouvertes au-delà du quota, jamais une en attente. */
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

/** Conversations qui portent un envoi optimiste pas encore confirmé. */
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
 * Persistance d'un fichier du cache, ouverte une fois par page. Sans OPFS, ou si le fichier ne
 * s'ouvre pas, le cache est en mémoire seulement : la synchro suffit.
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
        console.warn(`cache local indisponible pour ${name} :`, error)
        return null
      }
    })()
    opened.set(name, persistence)
  }
  return persistence
}

/** Note l'ouverture d'une conversation, puis évince ce qui dépasse le quota. */
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

/** Vide tout le cache : chaque fichier du chat dans l'OPFS, puis les registres. */
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
 * Cache du compte connecté : celui d'un autre compte, ou d'un compte déconnecté (`cleared`), est
 * vidé avant toute lecture.
 */
export async function claimCache(account: string, cleared: boolean) {
  const previous = localStorage.getItem(ACCOUNT_KEY)
  if (cleared || (previous !== null && previous !== account)) await clearCache()
  localStorage.setItem(ACCOUNT_KEY, account)
}
