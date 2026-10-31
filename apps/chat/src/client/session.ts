// Compte de la page, connu avant l'hydratation : il nomme les fichiers du cache local et sert de
// `author` aux messages. Le serveur le lit dans la requête, le navigateur le demande une fois.

import { createIsomorphicFn } from '@tanstack/react-start'

export type Me = { id: string; name: string; auth: 'bootstrap' | 'oidc' | 'proxy' }

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
    const { chat, req } = currentScope()
    return (await chat.me(req)) as Me | null
  })
  .client(loadBrowserMe)

/** Déconnexion : le cache du compte est vidé au prochain chargement, avant toute ouverture. */
export async function logout(account: string) {
  localStorage.setItem('wica-clear-account', account)
  await fetch('/auth/logout', { method: 'POST' })
  location.assign('/login')
}

export type AuthMode = Me['auth']

export const getAuthMode = createIsomorphicFn()
  .server(async (): Promise<AuthMode> => {
    const { currentScope } = await import('../server/context.ts')
    return currentScope().chat.authMode
  })
  .client(async (): Promise<AuthMode> => {
    const response = await fetch('/auth/mode')
    return ((await response.json()) as { kind: AuthMode }).kind
  })
