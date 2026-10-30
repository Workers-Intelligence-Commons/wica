// Le binaire local lancé comme un vrai processus, servi par stdio, devant un faux service
// Open Responses en HTTP local.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { createClient } from '@wica/client'
import { spawnStdio } from '@wica/transport-stdio'
import { describe, expect, it } from 'vite-plus/test'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))

function fakeService() {
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (c: Buffer) => (raw += c.toString()))
    request.on('end', () => {
      const body = JSON.parse(raw) as { input: { type: string }[] }
      const answered = body.input.some((i) => i.type === 'function_call_output')
      const item = answered
        ? {
            type: 'message',
            id: 'm',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Fin.', annotations: [] }],
          }
        : {
            type: 'function_call',
            id: 'f',
            call_id: 'k1',
            name: 'say',
            arguments: '{"text":"Bonjour !"}',
            status: 'completed',
          }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response: { output: [item] } })}\n\n`,
      )
    })
  })
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        close: () => server.close(),
      }),
    ),
  )
}

describe('binaire local', () => {
  it('sert une conversation par stdio, avec le modèle configuré par l’environnement', async () => {
    const service = await fakeService()
    const transport = spawnStdio(process.execPath, [main, 'serve', '--stdio'], {
      env: { ...process.env, WICA_MODEL_URL: service.url, WICA_MODEL: 'wpt' },
    })
    const client = createClient(transport, { from: { channel: 'local' } })
    await client.connect()
    await client.subscribe('c1')
    await client.send('c1', 'Salut')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('délai dépassé')), 10_000)
      const off = client.onChange('c1', () => {
        const done = client
          .view('c1')
          .entries.some((e) => e.type === 'assistant' && e.text === 'Fin.')
        if (!done) return
        clearTimeout(timer)
        off()
        resolve()
      })
    })
    expect(client.view('c1').entries.map((e) => e.type)).toEqual(['user', 'say', 'assistant'])
    await client.close()
    service.close()
  })
})
