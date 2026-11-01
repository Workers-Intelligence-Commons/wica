// Server entry point, the same for Compose and for Workers: the API and login routes first, then
// TanStack Start rendering. `#platform` chooses, at build time, the Node implementation or the
// Workers one; Workers also finds the conversation Durable Object class here.

import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { scheduled, startBackground, withHub } from '#platform'

import { withScope } from './server/context.ts'

const entry = createServerEntry({
  fetch(request, opts) {
    return withHub(request, (hub) =>
      withScope(
        { hub, req: request },
        async () => (await hub.handle(request)) ?? handler.fetch(request, opts),
      ),
    )
  },
})

export default {
  ...entry,
  ...(startBackground !== undefined ? { startBackground } : {}),
  ...(scheduled !== undefined ? { scheduled } : {}),
}

export { ConversationObject } from '#platform'
