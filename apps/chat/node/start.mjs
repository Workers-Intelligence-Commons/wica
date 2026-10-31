// Démarrage du Compose : sert les fichiers du client, passe le reste au serveur compilé, et lance
// la boucle des réveils. L'adresse du client remplace tout en-tête du même nom envoyé par le client,
// pour le proxy de confiance. Derrière Caddy, la connexion entrante vient toujours de Caddy : la
// dernière adresse de `X-Forwarded-For` est celle qu'il a vue, et il écrase celles de son client.

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
    // La requête de srvx sous Node n'est pas une `Request` que undici sait copier : elle est
    // reconstruite à partir de ses parties.
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
