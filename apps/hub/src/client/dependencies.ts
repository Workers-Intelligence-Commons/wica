// Dependencies of the browser `DbClient`: the account and the cache files already opened. A file
// opens asynchronously; a collection reads only the files that already are open.

import { type CacheFile, openCache } from './cache.ts'
import type { BrowserDependencies } from './collections.ts'

const ready = new Map<string, CacheFile | null>()
let account = ''

export function setBrowserCaches(id: string) {
  account = id
}

/** Opens a file and makes it readable by the collections created afterwards. */
export async function prepareCache(name: string) {
  ready.set(name, await openCache(name))
}

export const browserDependencies = (): BrowserDependencies => ({
  account,
  cache: (name) => ready.get(name) ?? null,
})
