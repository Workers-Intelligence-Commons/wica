// React binding of the client: the view of a conversation as React state, and its commands. No
// sync or rendering of its own: everything comes from `@wica/client`, which the application
// creates with its transport.

import type { Client, ConversationView } from '@wica/client'
import type { Part } from '@wica/core'
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react'

/**
 * The view of a conversation for `useSyncExternalStore`, which requires the same value as long as
 * nothing changes: `client.view` builds a new one at each call, so it is kept between two
 * changes. Without a subscriber, nothing is kept, so that a stale view is never returned.
 */
export function conversationStore(client: Client, conversationId: string) {
  let snapshot: ConversationView | null = null
  let subscribers = 0
  return {
    subscribe: (listener: () => void): (() => void) => {
      if (subscribers++ === 0) snapshot = null
      const off = client.onChange(conversationId, () => {
        snapshot = null
        listener()
      })
      return () => {
        off()
        if (--subscribers === 0) snapshot = null
      }
    },
    getSnapshot: (): ConversationView => {
      if (subscribers === 0) return client.view(conversationId)
      return (snapshot ??= client.view(conversationId))
    },
  }
}

/** The client commands, bound to a conversation. */
export const conversationCommands = (client: Client, conversationId: string) => ({
  send: (parts: Part[] | string, parentId?: string | null) =>
    client.send(conversationId, parts, parentId),
  answer: (callId: string, value: unknown) => client.answer(conversationId, callId, value),
  interrupt: () => client.interrupt(conversationId),
  setHead: (itemId: string) => client.setHead(conversationId, itemId),
  regenerate: (itemId: string) => client.regenerate(conversationId, itemId),
})

const ClientContext = createContext<Client | null>(null)

/** Gives the client to the components of the tree. */
export function WicaProvider(props: { client: Client; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children)
}

export function useWicaClient(): Client {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useWicaClient needs a WicaProvider higher in the tree.')
  return client
}

/** Subscribes to the conversation and returns its view, up to date at each change, and its commands. */
export function useConversation(conversationId: string) {
  const client = useWicaClient()
  const store = useMemo(() => conversationStore(client, conversationId), [client, conversationId])
  useEffect(() => void client.subscribe(conversationId), [client, conversationId])
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const commands = useMemo(
    () => conversationCommands(client, conversationId),
    [client, conversationId],
  )
  return { view, ...commands }
}
