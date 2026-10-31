// Compose startup: serves the client files, passes the rest to the compiled server, and starts
// the wake-up loop. The client address replaces any header of the same name sent by the client,
// for the trusted proxy. Behind Caddy, the incoming connection always comes from Caddy: the last
// address in `X-Forwarded-For` is the one it saw, and it overwrites those of its client.

import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'

import app from '../dist/server/server.js'

const stop = app.startBackground()
const behindCaddy = process.env.WICA_BEHIND_CADDY === '1'

const clientAddress = (request) =>
  behindCaddy
    ? request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || undefined
    : request.ip

const server = serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '0.0.0.0',
  middleware: [staticMiddleware({ dir: new URL('../dist/client', import.meta.url).pathname })],
  fetch(request) {
    const headers = new Headers(request.headers)
    headers.delete('x-wica-client-address')
    const address = clientAddress(request)
    if (address) headers.set('x-wica-client-address', address)
    // The srvx request under Node is not a `Request` that undici can copy: it is rebuilt from
    // its parts.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    return app.fetch(
      new Request(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
        ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
      }),
    )
  },
})

const shutdown = async () => {
  stop()
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
