// Context of a server-side request: the hub instance and the request, read by server rendering
// (row preloading) without passing them from function to function.

import { AsyncLocalStorage } from 'node:async_hooks'

import type { HubServer } from './app.ts'

export type RequestScope = { hub: HubServer; req: Request }

const storage = new AsyncLocalStorage<RequestScope>()

export const withScope = <T>(scope: RequestScope, fn: () => T): T => storage.run(scope, fn)

export function currentScope(): RequestScope {
  const scope = storage.getStore()
  if (!scope) throw new Error('No request in progress: call outside the hub server.')
  return scope
}
