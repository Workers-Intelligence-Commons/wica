import { MemoryStore, resilientStore } from '@wica/runtime'
import { storeConformance } from '@wica/testing'
import { describe, expect, it } from 'vite-plus/test'

import { dispatchStoreCall, httpStore, isStoreCall } from '../src/index.ts'

/** Le chat simulé : chaque appel traverse JSON puis `dispatchStoreCall`, comme `/api/remote/store`. */
function chatFetch(store: MemoryStore, failures = { left: 0 }): typeof fetch {
  return async (_url, init) => {
    if (failures.left > 0) {
      failures.left--
      return new Response('indisponible', { status: 503 })
    }
    const body: unknown = JSON.parse(init?.body as string)
    if (!isStoreCall(body)) return new Response('appel invalide', { status: 400 })
    return Response.json(await dispatchStoreCall(store, body))
  }
}

storeConformance('httpStore vers le chat', () =>
  httpStore({ url: 'https://chat.test', token: 't', fetch: chatFetch(new MemoryStore()) }),
)

describe('httpStore', () => {
  // Une coupure du chat ne doit pas faire échouer un tour : l'écriture est réessayée.
  it('réessaie une écriture pendant une panne passagère du chat', async () => {
    const failures = { left: 2 }
    const store = resilientStore(
      httpStore({
        url: 'https://chat.test',
        token: 't',
        fetch: chatFetch(new MemoryStore(), failures),
      }),
      { baseDelayMs: 1 },
    )
    const claim = await store.claim('c', 60_000)
    expect('epoch' in claim).toBe(true)
    expect(failures.left).toBe(0)
  })
})
