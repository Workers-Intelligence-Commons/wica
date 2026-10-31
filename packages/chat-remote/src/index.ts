// Remote server of the chat: a Harness server on a person's machine, or in a sandbox, that serves
// the chat conversations. It writes through the chat `Store` over HTTP and follows its command
// inbox through an Electric shape served by the chat proxy. Both sides of the API (call and
// dispatch) are here, so that they do not diverge.

import { type Message, type Offset, ShapeStream } from '@electric-sql/client'
import type { Envelope } from '@wica/protocol'
import { StaleEpochError, type Store } from '@wica/runtime'
import type { CommandInbox, InboxAck, InboxEntry } from '@wica/transport-inbox'

/** `Store` methods that can be called remotely. */
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

/** Conversation targeted by a call: every method takes it as its first argument. */
export const callConversation = (call: StoreCall) =>
  typeof call.args[0] === 'string' ? call.args[0] : null

/** Chat side: runs the call on the `Store`; a stale `epoch` becomes a response, not a failure. */
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
  /** Address of the chat, for example `https://chat.example.org`. */
  url: string
  /** Server token, given once when it is created in the chat. */
  token: string
  fetch?: typeof fetch
}

/** Transient failure of the chat: `resilientStore` retries it. */
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
    throw new ChatUnavailableError(`chat unavailable (${response.status})`)
  }
  if (!response.ok) throw new ChatRefusedError(`chat : ${response.status} ${await response.text()}`)
  return response.json()
}

/**
 * Chat `Store` over HTTP. A disconnection raises a network error or `ChatUnavailableError`, which
 * `resilientStore` from `@wica/runtime` retries; a stale `epoch` raises `StaleEpochError`.
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

/** Who this server is for the chat: its identifier and the account of its owner. */
export async function whoami(
  options: RemoteOptions,
): Promise<{ serverId: string; ownerId: string }> {
  return (await post(options, '/api/remote/whoami', {})) as { serverId: string; ownerId: string }
}

type CommandRow = { id: string; conversation_id: string; payload: Envelope; created_at: string }

/** Inbox cursor: the shape and the position in its journal. */
const encodeCursor = (handle: string | undefined, offset: Offset) => `${handle ?? ''} ${offset}`
const decodeCursor = (cursor: string) => {
  const [handle, offset] = cursor.split(' ')
  return { handle: handle || undefined, offset: (offset || '-1') as Offset }
}

/**
 * Command inbox of the chat. Without a cursor, the shape starts with the commands that have no
 * acknowledgement; with a cursor, it resumes at its position. The Electric client reconnects on
 * its own: the stream ends only on an error it cannot recover from, or on stop.
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
      // The position moves forward only after the last item of a batch: a resume in the middle of
      // a batch reads it again in full, and the server discards the commands already processed.
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
