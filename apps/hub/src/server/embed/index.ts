// The guest chat component on other sites: which sites may hold it, the cross-site headers of the
// guest routes it calls, and the one route that tells it how to sync. A request from another
// site is always a guest's: its cookies and its authorization are dropped, and no response
// allows credentials, so an account never answers another site.

import type { EmbedInfo } from '../../shared/embed.ts'
import type { HubConfig } from '../config.ts'

/** Sections of `/api/` that the component calls. */
const SECTIONS: ReadonlySet<string> = new Set([
  'embed',
  'guest',
  'live-ticket',
  'shapes',
  'commands',
  'conversations',
])

const ALLOWED_HEADERS = 'content-type, x-wica-guest, x-wica-fingerprint, x-wica-session'
/** Headers the component reads: its harness session, and the position of each shape. */
const EXPOSED_HEADERS = [
  'x-wica-session',
  'electric-handle',
  'electric-offset',
  'electric-schema',
  'electric-cursor',
  'electric-up-to-date',
].join(', ')
const PREFLIGHT_MAX_AGE_S = '600'

export function embedding(config: HubConfig, info: EmbedInfo) {
  const origins = new Set(config.embed?.origins ?? [])

  function crossSiteHeaders(origin: string) {
    return new Headers({ 'access-control-allow-origin': origin, vary: 'Origin' })
  }

  return {
    /** `GET /api/embed`; absent when no site may hold the component. */
    info(): Response {
      if (origins.size === 0) {
        return Response.json({ error: 'no site may embed this hub' }, { status: 404 })
      }
      return Response.json(info, { headers: { 'cache-control': 'no-store' } })
    },

    /**
     * Runs `next` for a request to `/api/<section>`. Another site gets the cross-site headers
     * only when it is allowed and the route is one of the component's; its live socket opens
     * only when it is allowed.
     */
    async serve(
      req: Request,
      section: string | undefined,
      next: (req: Request) => Promise<Response>,
    ): Promise<Response> {
      const origin = req.headers.get('origin')
      if (!origin || origin === new URL(req.url).origin) return next(req)
      const allowed = origins.has(origin)
      if (section === 'live') {
        return allowed
          ? next(req)
          : Response.json({ error: 'this site may not embed this hub' }, { status: 403 })
      }
      if (!allowed || !section || !SECTIONS.has(section)) return next(req)
      const headers = crossSiteHeaders(origin)
      if (req.method === 'OPTIONS') {
        headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
        headers.set('access-control-allow-headers', ALLOWED_HEADERS)
        headers.set('access-control-max-age', PREFLIGHT_MAX_AGE_S)
        return new Response(null, { status: 204, headers })
      }
      const guestOnly = new Headers(req.headers)
      guestOnly.delete('cookie')
      guestOnly.delete('authorization')
      const response = await next(new Request(req, { headers: guestOnly }))
      const out = new Response(response.body, response)
      out.headers.set('access-control-allow-origin', origin)
      out.headers.set('access-control-expose-headers', EXPOSED_HEADERS)
      out.headers.delete('access-control-allow-credentials')
      const vary = out.headers.get('vary')
      out.headers.set('vary', vary ? `${vary}, Origin` : 'Origin')
      return out
    },
  }
}
