// Routeur de l'application : un `DbClient` par requête serveur et un pour le navigateur.

import { DbClient } from '@tanstack/react-db'
import { createRouter } from '@tanstack/react-router'
import { routerWithDbClient } from '@tanstack/react-router-with-db'

import { browserDependencies } from './client/dependencies.ts'
import type { ServerRows } from './client/collections.ts'
import { routeTree } from './routeTree.gen.ts'

export type RouterContext = { dbClient: DbClient }

const serverRows: ServerRows = async (table, conversationId) =>
  (await import('./server/ssr-rows.ts')).serverRows(table, conversationId)

export function getRouter() {
  const dbClient = import.meta.env.SSR
    ? new DbClient({ serverRows })
    : new DbClient({ browser: browserDependencies() })
  const router = createRouter({
    routeTree,
    context: { dbClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
  return routerWithDbClient(router, dbClient)
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
