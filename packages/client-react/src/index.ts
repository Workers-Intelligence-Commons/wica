// Liaison React du client (specs/harness.md, Découpage en dossiers du monorepo) : la vue d'une
// conversation comme état React, et ses commandes. Ni synchro ni rendu propres : tout vient de
// `@wica/client`, que l'application crée avec son transport.

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
 * La vue d'une conversation pour `useSyncExternalStore`, qui exige la même valeur tant que rien
 * ne change : `client.view` en construit une nouvelle à chaque appel, elle est donc gardée entre
 * deux changements. Sans abonné, rien n'est gardé, pour ne jamais rendre une vue périmée.
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

/** Les commandes du client, liées à une conversation. */
export const conversationCommands = (client: Client, conversationId: string) => ({
  send: (parts: Part[] | string, parentId?: string | null) =>
    client.send(conversationId, parts, parentId),
  answer: (callId: string, value: unknown) => client.answer(conversationId, callId, value),
  interrupt: () => client.interrupt(conversationId),
  setHead: (itemId: string) => client.setHead(conversationId, itemId),
  regenerate: (itemId: string) => client.regenerate(conversationId, itemId),
})

const ClientContext = createContext<Client | null>(null)

/** Donne le client aux composants de l'arbre. */
export function WicaProvider(props: { client: Client; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children)
}

export function useWicaClient(): Client {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useWicaClient demande un WicaProvider plus haut dans l’arbre.')
  return client
}

/** S'abonne à la conversation et rend sa vue, à jour à chaque changement, et ses commandes. */
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
