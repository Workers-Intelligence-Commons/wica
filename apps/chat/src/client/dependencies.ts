// Dépendances du `DbClient` du navigateur : le compte et les fichiers du cache déjà ouverts.
// Un fichier s'ouvre en asynchrone ; une collection ne lit que ceux qui le sont déjà.

import { openCache, type CachePersistence } from './cache.ts'
import type { BrowserDependencies } from './collections.ts'

const ready = new Map<string, CachePersistence | null>()
let account = ''

export function setBrowserCaches(id: string) {
  account = id
}

/** Ouvre un fichier et le rend lisible par les collections créées ensuite. */
export async function prepareCache(name: string) {
  ready.set(name, await openCache(name))
}

export const browserDependencies = (): BrowserDependencies => ({
  account,
  cache: (name) => ready.get(name) ?? null,
})
