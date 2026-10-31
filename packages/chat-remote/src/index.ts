// Serveur distant du chat : un serveur du Harness sur la machine d'une personne, ou dans un bac
// à sable, qui sert les conversations du chat. Il écrit par le `Store` du chat en HTTP et suit
// sa boîte de commandes par une shape Electric servie par le proxy du chat. Les deux côtés de
// l'API (appel et répartition) sont ici, pour qu'ils ne divergent pas.

import { type Message, type Offset, ShapeStream } from '@electric-sql/client'
import type { Envelope } from '@wica/protocol'
import { StaleEpochError, type Store } from '@wica/runtime'
import type { CommandInbox, InboxAck, InboxEntry } from '@wica/transport-inbox'

/** Méthodes du `Store` appelables à distance. */
export const STORE_METHODS = [
  'claim',
  'renew',
  'release',
  'load',
  'append',
  'appendBatch',
  'settle',
  'setHead',
  'requestInterrupt',
  'clearInterrupt',
  'claimToolCall',
  'loadSnapshot',
  'saveSnapshot',
] as const satisfies readonly (keyof Store)[]

export type StoreMethod = (typeof STORE_METHODS)[number]

export type StoreCall = { method: StoreMethod; args: unknown[] }

export type StoreReply = { ok: true; value: unknown } | { ok: false; stale: true; message: string }

export const isStoreCall = (body: unknown): body is StoreCall =>
  typeof body === 'object' &&
  body !== null &&
  (STORE_METHODS as readonly string[]).includes((body as StoreCall).method) &&
  Array.isArray((body as StoreCall).args)

/** Conversation visée par un appel : toutes les méthodes la prennent en premier argument. */
export const callConversation = (call: StoreCall) =>
  typeof call.args[0] === 'string' ? call.args[0] : null

/** Côté chat : exécute l'appel sur le `Store` ; un `epoch` périmé devient une réponse, pas une panne. */
export async function dispatchStoreCall(store: Store, call: StoreCall): Promise<StoreReply> {
  try {
    const method = store[call.method] as (...args: unknown[]) => Promise<unknown>
    const value = await method.apply(store, call.args)
    return { ok: true, value: value ?? null }
  } catch (error) {
    if (error instanceof StaleEpochError) return { ok: false, stale: true, message: error.message }
    throw error
  }
}

export type RemoteOptions = {
  /** Adresse du chat, par exemple `https://chat.example.org`. */
  url: string
  /** Jeton du serveur, donné une fois à sa création dans le chat. */
  token: string
  fetch?: typeof fetch
}

/** Panne passagère du chat : `resilientStore` la réessaie. */
export class ChatUnavailableError extends Error {
  override name = 'ChatUnavailableError'
  readonly retryable = true
}

export class ChatRefusedError extends Error {
  override name = 'ChatRefusedError'
}

async function post(options: RemoteOptions, path: string, body: unknown): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(new URL(path, options.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status >= 500 || response.status === 429) {
    throw new ChatUnavailableError(`chat indisponible (${response.status})`)
  }
  if (!response.ok) throw new ChatRefusedError(`chat : ${response.status} ${await response.text()}`)
  return response.json()
}

/**
 * `Store` du chat en HTTP. Une coupure lève une erreur de réseau ou `ChatUnavailableError`,
 * que `resilientStore` de `@wica/runtime` réessaie ; un `epoch` périmé lève `StaleEpochError`.
 */
export function httpStore(options: RemoteOptions): Store {
  const call =
    (method: StoreMethod) =>
    async (...args: unknown[]) => {
      const reply = (await post(options, '/api/remote/store', { method, args })) as StoreReply
      if (!reply.ok) throw new StaleEpochError(reply.message)
      return reply.value === null && method === 'loadSnapshot' ? undefined : reply.value
    }
  return Object.fromEntries(STORE_METHODS.map((m) => [m, call(m)])) as unknown as Store
}

/** Qui est ce serveur pour le chat : son identifiant et le compte de son propriétaire. */
export async function whoami(
  options: RemoteOptions,
): Promise<{ serverId: string; ownerId: string }> {
  return (await post(options, '/api/remote/whoami', {})) as { serverId: string; ownerId: string }
}

type CommandRow = { id: string; conversation_id: string; payload: Envelope; created_at: string }

/** Curseur de la boîte : la shape et la position dans son journal. */
const encodeCursor = (handle: string | undefined, offset: Offset) => `${handle ?? ''} ${offset}`
const decodeCursor = (cursor: string) => {
  const [handle, offset] = cursor.split(' ')
  return { handle: handle || undefined, offset: (offset || '-1') as Offset }
}

/**
 * Boîte de commandes du chat. Sans curseur, la shape commence par les commandes sans accusé ;
 * avec un curseur, elle reprend à sa position. Le client Electric se reconnecte seul : le flux
 * ne finit que sur une erreur qu'il ne sait pas reprendre, ou à l'arrêt.
 */
export function chatInbox(options: RemoteOptions): CommandInbox {
  return {
    async *follow(cursor: string | null, signal: AbortSignal): AsyncIterable<InboxEntry> {
      const position = cursor ? decodeCursor(cursor) : { handle: undefined, offset: '-1' as Offset }
      const stream = new ShapeStream<CommandRow>({
        url: new URL('/api/remote/shapes/commands', options.url).toString(),
        headers: { authorization: `Bearer ${options.token}` },
        offset: position.offset,
        ...(position.handle ? { handle: position.handle } : {}),
        signal,
        ...(options.fetch ? { fetchClient: options.fetch } : {}),
      })
      const queue: InboxEntry[] = []
      let failure: Error | null = null
      let wake: () => void = () => {}
      // La position n'avance qu'après le dernier élément d'un lot : une reprise en plein lot le
      // relit en entier, et le serveur écarte les commandes déjà traitées.
      let before = encodeCursor(position.handle, position.offset)
      const unsubscribe = stream.subscribe(
        (messages: Message<CommandRow>[]) => {
          const inserts = messages.filter(
            (m): m is Extract<Message<CommandRow>, { key: string }> =>
              'key' in m && m.headers.operation === 'insert',
          )
          const after = encodeCursor(stream.shapeHandle, stream.lastOffset)
          inserts.forEach((message, i) =>
            queue.push({
              cursor: i === inserts.length - 1 ? after : before,
              envelope: message.value.payload,
            }),
          )
          before = after
          wake()
        },
        (error) => {
          failure = error
          wake()
        },
      )
      const aborted = () => wake()
      signal.addEventListener('abort', aborted, { once: true })
      try {
        for (;;) {
          while (queue.length > 0) yield queue.shift() as InboxEntry
          if (failure) throw failure
          if (signal.aborted) return
          await new Promise<void>((resolve) => (wake = resolve))
        }
      } finally {
        unsubscribe()
        signal.removeEventListener('abort', aborted)
      }
    },
    async ack(commandId: string, result: InboxAck) {
      await post(options, '/api/remote/ack', { commandId, result })
    },
    async heartbeat() {
      await post(options, '/api/remote/heartbeat', {})
    },
  }
}
