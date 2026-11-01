// Compose startup: serves the client files, passes the rest to the compiled server, and starts
// the wake-up loop. Behind Caddy, the request takes the protocol (`X-Forwarded-Proto`) and the
// host (`X-Forwarded-Host`) that the browser used, in its address and in its `Host` header: the
// sign-in compares them with the browser's `Origin`, and the hub builds its return addresses and
// email links from them.

import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'

import app from '../dist/server/server.js'

const stop = app.startBackground()
const behindCaddy = process.env.WICA_BEHIND_CADDY === '1'
/** A host name or address, with an optional port. */
const HOST = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i

/**
 * The person's network address, for the daily messages of guests. Behind Caddy, the connection
 * comes from Caddy: the last address of `X-Forwarded-For` is the one it saw.
 */
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
    // A client never chooses its own address.
    headers.delete('x-wica-client-address')
    const address = clientAddress(request)
    if (address) headers.set('x-wica-client-address', address)
    // The srvx request under Node is not a `Request` that undici can copy: it is rebuilt from
    // its parts.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const url = new URL(request.url)
    if (behindCaddy) {
      const protocol = request.headers.get('x-forwarded-proto')
      if (protocol === 'https' || protocol === 'http') url.protocol = `${protocol}:`
      const host = request.headers.get('x-forwarded-host')?.split(',').at(-1)?.trim()
      if (host && HOST.test(host)) {
        url.host = host
        headers.set('host', host)
      }
    }
    return app.fetch(
      new Request(url, {
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
