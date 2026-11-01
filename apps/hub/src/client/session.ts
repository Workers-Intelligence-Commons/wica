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

/**
 * Who uses the page: an account, or a guest once they agreed to the fingerprint. `id` names the
 * cache files and is the author of the messages.
 */
export type Viewer = { kind: 'user' | 'guest'; id: string }

/** The next read of the account asks the server again, after a change to it. */
export function forgetBrowserMe() {
  browserMe = undefined
}

/**
 * A new sign-in of the same account, then back to `next`: the hub's own accounts sign out and
 * sign in on the login page; an OIDC issuer is asked for a new sign-in even if it holds a session.
 */
export async function signInAgain(me: Me, next: string) {
  if (me.auth === 'oidc') {
    location.assign(`/auth/oidc?fresh=1&next=${encodeURIComponent(next)}`)
    return
  }
  await fetch('/auth/logout', { method: 'POST' })
  location.assign(`/login?next=${encodeURIComponent(next)}`)
}
