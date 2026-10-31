// The conformance suites on the repository implementations.

import { PassThrough } from 'node:stream'

import { openResponsesModel } from '@wica/model-compat'
import type { ClientFrame, ServerFrame, ServerTransport } from '@wica/protocol'
import { MemoryStore, resilientStore } from '@wica/runtime'
import { memoryTransportPair } from '@wica/transport-memory'
import { stdioTransport } from '@wica/transport-stdio'
import { connectWebSocket } from '@wica/transport-ws'
import { listenWebSocket } from '@wica/transport-ws/node'

import {
  endlessOpenResponsesStream,
  type ModelScenario,
  modelAdapterConformance,
  openResponsesCall,
  openResponsesMessage,
  openResponsesStream,
  storeConformance,
  transportConformance,
} from '../src/index.ts'

storeConformance('MemoryStore', () => new MemoryStore())
storeConformance('resilientStore', () => resilientStore(new MemoryStore()))

transportConformance('memory', async () => memoryTransportPair())

transportConformance('stdio', async () => {
  const up = new PassThrough()
  const down = new PassThrough()
  return {
    client: stdioTransport<ClientFrame, ServerFrame>(down, up),
    server: stdioTransport<ServerFrame, ClientFrame>(up, down),
  }
})

transportConformance('WebSocket', async () => {
  let accepted: (t: ServerTransport) => void = () => {}
  const server = new Promise<ServerTransport>((resolve) => (accepted = resolve))
  const listening = await listenWebSocket({ port: 0, host: '127.0.0.1' }, accepted)
  const client = connectWebSocket(`ws://127.0.0.1:${listening.port}`)
  // The connection opens only at the first send or the first read of the client.
  void client.send({ kind: 'ping' })
  const transport = await server
  const frames = transport.receive()[Symbol.asyncIterator]()
  await frames.next()
  return {
    client,
    server: { ...transport, receive: () => ({ [Symbol.asyncIterator]: () => frames }) },
    close: () => listening.close(),
  }
})

const scenarios: Record<ModelScenario, (signal: AbortSignal | null | undefined) => Response> = {
  text: () => openResponsesStream([openResponsesMessage('Hello.')]),
  tool_call: () => openResponsesStream([openResponsesCall('k1', 'read_file', { path: 'a.txt' })]),
  failure: () =>
    new Response(JSON.stringify({ error: { message: 'unknown model', code: 'model_not_found' } }), {
      status: 404,
    }),
  endless: (signal) => endlessOpenResponsesStream(signal),
}

modelAdapterConformance('model-compat', (scenario) =>
  openResponsesModel({
    baseUrl: 'http://service/v1',
    model: 'm',
    fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
      scenarios[scenario](init?.signal)) as typeof fetch,
  }),
)
