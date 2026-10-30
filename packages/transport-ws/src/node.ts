// Serveur WebSocket pour Node, bâti sur la bibliothèque `ws` : chaque connexion entrante devient
// un `ServerTransport`. Les autres plateformes passent leur socket à `serveWebSocket`.

import type { IncomingMessage } from 'node:http'

import type { ServerTransport } from '@wica/protocol'
import { WebSocketServer } from 'ws'

import { serveWebSocket, type SocketLike } from './index.ts'

export type ListenOptions = {
  port: number
  host?: string
  /** Refuse une connexion avant le protocole, par exemple sur l'origine ; tout passe par défaut. */
  accept?: (request: IncomingMessage) => boolean
}

export type Listening = {
  port: number
  /** Ferme le serveur et coupe les connexions ouvertes. */
  close: () => Promise<void>
  /** Coupe toutes les connexions sans fermer le serveur (sert aux tests de coupure). */
  dropConnections: () => void
}

export function listenWebSocket(
  options: ListenOptions,
  onTransport: (transport: ServerTransport, request: IncomingMessage) => void,
): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
      ...(options.accept
        ? { verifyClient: (info: { req: IncomingMessage }) => options.accept!(info.req) }
        : {}),
    })
    server.on('error', reject)
    server.on('connection', (socket, request) =>
      onTransport(serveWebSocket(socket as unknown as SocketLike), request),
    )
    server.on('listening', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            for (const client of server.clients) client.terminate()
            server.close(() => done())
          }),
        dropConnections: () => {
          for (const client of server.clients) client.terminate()
        },
      })
    })
  })
}
