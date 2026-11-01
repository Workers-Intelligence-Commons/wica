// Account of the page, known before hydration: it names the local cache files and serves as the
// `author` of messages. The server reads it from the request, the browser asks for it once.

import { createIsomorphicFn } from '@tanstack/react-start'

import type { Me, SignIn } from '../shared/session.ts'

export type { Me, SignIn }

let browserMe: Me | null | undefined

export async function loadBrowserMe(): Promise<Me | null> {
  if (browserMe !== undefined) return browserMe
  const response = await fetch('/api/me', { headers: { accept: 'application/json' } })
  browserMe = response.ok ? ((await response.json()) as Me | null) : null
  return browserMe
}

export const getMe = createIsomorphicFn()
  .server(async (): Promise<Me | null> => {
    const { currentScope } = await import('../server/context.ts')
    const { hub, req } = currentScope()
    return hub.me(req)
  })
  .client(loadBrowserMe)

/** Logout, which also ends the Better Auth session: the account cache is cleared on the next load, before anything opens. */
export async function logout(account: string) {
  localStorage.setItem('wica-clear-account', account)
  await fetch('/auth/logout', { method: 'POST' })
  location.assign('/login')
}

export const getSignIn = createIsomorphicFn()
  .server(async (): Promise<SignIn> => {
    const { currentScope } = await import('../server/context.ts')
    return currentScope().hub.signIn
  })
  .client(async (): Promise<SignIn> => {
    const response = await fetch('/auth/mode')
    return (await response.json()) as SignIn
  })
