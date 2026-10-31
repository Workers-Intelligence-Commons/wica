// Server entry point, the same for Compose and for Workers: the API and login routes first, then
// TanStack Start rendering. `#platform` chooses, at build time, the Node implementation or the
// Workers one.

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
