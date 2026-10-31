// Une requête HTTP vue comme une connexion du protocole client : un `hello`, une commande, puis
// l'accusé. Le serveur embarqué traite ainsi chaque commande dans la requête qui l'apporte, sans
// connexion durable, ce qui convient à Workers comme au Compose.

import {
  type Envelope,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type ServerTransport,
} from '@wica/protocol'

export type OneShotResult = {
  sessionId: string
  ack: Extract<ServerFrame, { kind: 'ack' }>
}

export function oneShot(hello: { token: string; sessionId?: string }, envelope: Envelope) {
  let settle: (r: OneShotResult) => void = () => {}
  let fail: (e: Error) => void = () => {}
  const result = new Promise<OneShotResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let sessionId: string | null = null
  const transport: ServerTransport = {
    async send(frame) {
      if (frame.kind === 'welcome') {
        sessionId = frame.sessionId
      } else if (frame.kind === 'ack' && frame.commandId === envelope.commandId) {
        settle({ sessionId: sessionId ?? '', ack: frame })
      } else if (frame.kind === 'error' && !frame.conversationId) {
        fail(new Error(frame.message))
      }
    },
    async *receive(): AsyncIterable<ClientFrame> {
      yield {
        kind: 'hello',
        version: PROTOCOL_VERSION,
        token: hello.token,
        ...(hello.sessionId ? { sessionId: hello.sessionId } : {}),
      }
      // La commande porte la session du client ; le serveur la range sous la sienne.
      yield envelope
    },
    async close() {},
  }
  return { transport, result }
}
