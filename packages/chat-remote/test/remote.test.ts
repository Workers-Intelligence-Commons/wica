import { MemoryStore, resilientStore } from '@wica/runtime'
import { storeConformance } from '@wica/testing'
import { describe, expect, it } from 'vite-plus/test'

import { dispatchStoreCall, httpStore, isStoreCall } from '../src/index.ts'

/** The simulated chat: each call goes through JSON then `dispatchStoreCall`, like `/api/remote/store`. */
function chatFetch(store: MemoryStore, failures = { left: 0 }): typeof fetch {
  return async (_url, init) => {
    if (failures.left > 0) {
      failures.left--
      return new Response('unavailable', { status: 503 })
    }
    const body: unknown = JSON.parse(init?.body as string)
    if (!isStoreCall(body)) return new Response('invalid call', { status: 400 })
    return Response.json(await dispatchStoreCall(store, body))
  }
}

storeConformance('httpStore to the chat', () =>
  httpStore({ url: 'https://chat.test', token: 't', fetch: chatFetch(new MemoryStore()) }),
)

describe('httpStore', () => {
  // A chat disconnection must not make a turn fail: the write is retried.
  it('retries a write during a transient chat failure', async () => {
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
