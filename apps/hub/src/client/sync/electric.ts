// Browser sync through Electric (Compose): each collection follows a shape served by the
// application proxy. A message is confirmed when its row comes back in the shape; a new
// conversation, when the transaction that created it reaches the shape.

import { electricCollectionOptions, isChangeMessage } from '@tanstack/electric-db-collection'

import type { ShapeTable } from '../../shared/rows.ts'
import { guestHeaders } from '../guest.ts'

type Utils = Record<string, unknown>

type AwaitMatch = (
  fn: (message: Parameters<typeof isChangeMessage>[0]) => boolean,
  timeout?: number,
) => Promise<boolean>

export function electricSync<T extends Record<string, unknown>>(options: {
  id: string
  getKey: (row: T) => string
  table: ShapeTable
  conversationId?: string
  gcTime?: number
}) {
  return electricCollectionOptions<T>({
    id: options.id,
    getKey: options.getKey,
    ...(options.gcTime !== undefined ? { gcTime: options.gcTime } : {}),
    shapeOptions: {
      url: new URL(`/api/shapes/${options.table}`, location.origin).toString(),
      // A guest's key, read at each request: it may be created after the collection.
      headers: Object.fromEntries(
        ['x-wica-guest', 'x-wica-fingerprint'].map((name) => [
          name,
          () => guestHeaders()[name] ?? '',
        ]),
      ),
      ...(options.conversationId ? { params: { conversation: options.conversationId } } : {}),
    },
  })
}

/** Waits for the item `id` written by the server; `null` when the collection has no sync. */
export function rowConfirmation(collection: { utils: Utils }) {
  const awaitMatch = collection.utils['awaitMatch'] as AwaitMatch | undefined
  if (!awaitMatch) return null
  return (id: string, timeoutMs: number) =>
    awaitMatch(
      (message) => isChangeMessage(message) && (message.value as { id?: string }).id === id,
      timeoutMs,
    )
}

export async function awaitCreated(
  collection: { utils: Utils },
  created: { id: string; txid?: number },
  timeoutMs: number,
) {
  const awaitTxId = collection.utils['awaitTxId'] as
    | ((txid: number, timeout?: number) => Promise<boolean>)
    | undefined
  if (awaitTxId && created.txid !== undefined) await awaitTxId(created.txid, timeoutMs)
}

/** The shapes follow every change on their own. */
export const refreshList = () => {}
