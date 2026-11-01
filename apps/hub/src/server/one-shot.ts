// An HTTP request seen as a client protocol connection: a `hello`, a command, then the
// acknowledgement. The embedded server thus processes each command in the request that brings
// it, without a lasting connection, which suits Workers as well as Compose.

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
      // The command carries the client session; the server files it under its own.
      yield envelope
    },
    async close() {},
  }
  return { transport, result }
}
