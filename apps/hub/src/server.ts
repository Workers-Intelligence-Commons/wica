// Server entry point, the same for Compose and for Workers: the API and login routes first, then
// TanStack Start rendering. `#platform` chooses, at build time, the Node implementation or the
// Workers one; Workers also finds the conversation Durable Object class here.

import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { scheduled, startBackground, withHub } from '#platform'

import { withScope } from './server/context.ts'

const entry = createServerEntry({
  async fetch(request, opts) {
    const response = await withHub(request, (hub) =>
      withScope(
        { hub, req: request },
        async () => (await hub.handle(request)) ?? handler.fetch(request, opts),
      ),
    )
    return refuseFraming(response)
  },
})

/**
 * No page of the hub shows inside another site, which could hide it under its own and make a
 * person click it unknowingly; other sites hold the guest chat component instead.
 */
function refuseFraming(response: Response) {
  // A socket upgrade carries its socket in the response, which a copy would lose.
  if (response.status === 101) return response
  const out = new Response(response.body, response)
  out.headers.set('content-security-policy', "frame-ancestors 'none'")
  out.headers.set('x-frame-options', 'DENY')
  return out
}

export default {
  ...entry,
  ...(startBackground !== undefined ? { startBackground } : {}),
  ...(scheduled !== undefined ? { scheduled } : {}),
}

export { ConversationObject } from '#platform'
