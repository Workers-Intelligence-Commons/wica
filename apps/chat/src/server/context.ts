// Context of a server-side request: the chat instance and the request, read by server rendering
// (row preloading) without passing them from function to function.

import { AsyncLocalStorage } from 'node:async_hooks'

import type { ChatServer } from './app.ts'

export type RequestScope = { chat: ChatServer; req: Request }

const storage = new AsyncLocalStorage<RequestScope>()

export const withScope = <T>(scope: RequestScope, fn: () => T): T => storage.run(scope, fn)

export function currentScope(): RequestScope {
  const scope = storage.getStore()
  if (!scope) throw new Error('No request in progress: call outside the chat server.')
  return scope
}
