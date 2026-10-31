// Entrée du serveur, la même pour le Compose et pour Workers : les routes de l'API et de
// connexion d'abord, puis le rendu de TanStack Start. `#platform` choisit, à la compilation,
// l'implémentation de Node ou celle de Workers.

import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { queue, startBackground, withChat } from '#platform'

import { withScope } from './server/context.ts'

const entry = createServerEntry({
  fetch(request, opts) {
    return withChat(request, (chat) =>
      withScope(
        { chat, req: request },
        async () => (await chat.handle(request)) ?? handler.fetch(request, opts),
      ),
    )
  },
})

export default {
  ...entry,
  ...(queue !== undefined ? { queue } : {}),
  ...(startBackground !== undefined ? { startBackground } : {}),
}
