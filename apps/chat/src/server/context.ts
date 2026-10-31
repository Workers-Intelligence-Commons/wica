// Contexte d'une requête côté serveur : l'instance du chat et la requête, lus par le rendu
// serveur (préchargement des lignes) sans les passer de fonction en fonction.

import { AsyncLocalStorage } from 'node:async_hooks'

import type { ChatServer } from './app.ts'

export type RequestScope = { chat: ChatServer; req: Request }

const storage = new AsyncLocalStorage<RequestScope>()

export const withScope = <T>(scope: RequestScope, fn: () => T): T => storage.run(scope, fn)

export function currentScope(): RequestScope {
  const scope = storage.getStore()
  if (!scope) throw new Error('Aucune requête en cours : appel hors du serveur du chat.')
  return scope
}
