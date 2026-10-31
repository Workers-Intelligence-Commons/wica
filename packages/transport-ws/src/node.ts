// WebSocket server for Node, built on the `ws` library: each incoming connection becomes a
// `ServerTransport`. The other platforms pass their socket to `serveWebSocket`.

import type { IncomingMessage } from 'node:http'

import type { ServerTransport } from '@wica/protocol'
import { WebSocketServer } from 'ws'

import { serveWebSocket, type SocketLike } from './index.ts'

export type ListenOptions = {
  port: number
  host?: string
  /** Refuses a connection before the protocol, for example on the origin; everything passes by default. */
  accept?: (request: IncomingMessage) => boolean
}

export type Listening = {
  port: number
  /** Closes the server and cuts the open connections. */
  close: () => Promise<void>
  /** Cuts all connections without closing the server (serves the disconnection tests). */
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
