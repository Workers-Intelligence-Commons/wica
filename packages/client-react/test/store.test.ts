import type { Client, ConversationView } from '@wica/client'
import { describe, expect, it } from 'vite-plus/test'

import { conversationStore } from '../src/index.ts'

/** Faux client : une vue neuve à chaque appel, comme le vrai, et des changements à la demande. */
function fakeClient() {
  let head = 'a'
  const listeners = new Set<() => void>()
  const client = {
    view: (): ConversationView => ({
      head,
      entries: [],
      waiting: [],
      clientCalls: [],
      settled: true,
    }),
    onChange: (_id: string, listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as Client
  const change = (next: string) => {
    head = next
    for (const l of listeners) l()
  }
  return { client, change }
}

describe('conversationStore', () => {
  // useSyncExternalStore boucle sans fin si la valeur change à chaque lecture sans changement.
  it('rend la même vue entre deux changements, et la nouvelle après un changement', () => {
    const { client, change } = fakeClient()
    const store = conversationStore(client, 'c1')
    let notified = 0
    const off = store.subscribe(() => (notified += 1))
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)

    change('b')
    expect(notified).toBe(1)
    expect(store.getSnapshot()).not.toBe(first)
    expect(store.getSnapshot().head).toBe('b')
    off()
  })

  it('ne garde rien de périmé quand personne n’écoute', () => {
    const { client, change } = fakeClient()
    const store = conversationStore(client, 'c1')
    const off = store.subscribe(() => {})
    expect(store.getSnapshot().head).toBe('a')
    off()
    change('b')
    expect(store.getSnapshot().head).toBe('b')
    const again = store.subscribe(() => {})
    expect(store.getSnapshot().head).toBe('b')
    again()
  })
})
