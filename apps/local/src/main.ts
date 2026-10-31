#!/usr/bin/env node
// Standalone local binary ("all local" topology):
//   wica                          command-line client, server launched over stdio
//   wica serve --stdio            serves the client protocol on stdin and stdout
//   wica serve --ws [--port N] [--host H] [--token T]
//   wica connect <url> --token T  client to a WebSocket server
//   wica acp                      agent for an editor, through the Agent Client Protocol on stdio
//   wica remote <url>             remote server of a chat, token in WICA_CHAT_TOKEN

import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { createClient } from '@wica/client'
import type { ClientTransport } from '@wica/protocol'
import { pairingTokenAuth } from '@wica/runtime'
import { serveStdio, spawnStdio } from '@wica/transport-stdio'
import { connectWebSocket } from '@wica/transport-ws'
import { listenWebSocket } from '@wica/transport-ws/node'

import { serveAcp } from './acp.ts'
import { runCli } from './cli.ts'
import { serveRemote } from './remote.ts'
import { ConfigError, configFromEnv, createLocalServer } from './server.ts'

const USAGE = `Usage:
  wica [--yes] [--conversation ID]
  wica serve --stdio [--yes]
  wica serve --ws [--port 7777] [--host 127.0.0.1] [--token TOKEN] [--yes]
  wica connect ws://host:port --token TOKEN [--conversation ID]
  wica acp [--yes]
  WICA_CHAT_TOKEN=TOKEN wica remote https://chat.example.org [--yes]

Model: WICA_MODEL_URL, WICA_MODEL, WICA_API_KEY (optional), WICA_REASONING_EFFORT (optional).
Without a model server: WICA_MODEL=lorem (text written in advance) or lorem-tools (one tool at each turn).
--yes allows every tool without asking; otherwise every action that is not a read asks for approval.`

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stdio: { type: 'boolean' },
      ws: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      yes: { type: 'boolean' },
      conversation: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, target] = positionals
  if (values.help) return void process.stdout.write(`${USAGE}\n`)

  const config = () =>
    configFromEnv(process.env, { root: process.cwd(), allowAll: values.yes === true })

  if (command === 'acp') {
    // stdout carries ACP: nothing else must be written there.
    await serveAcp(config())
    return
  }

  if (command === 'remote') {
    if (!target) throw new ConfigError('remote needs the address of the chat.')
    const token = process.env.WICA_CHAT_TOKEN
    if (!token)
      throw new ConfigError(
        'WICA_CHAT_TOKEN is required: token given by the chat when the server is created.',
      )
    const { serverId, done } = await serveRemote(config(), { url: target, token }, (message) => {
      process.stderr.write(`the chat refuses this server: ${message}\n`)
      process.exit(1)
    })
    process.stderr.write(`server ${serverId} linked to ${target}, folder ${process.cwd()}\n`)
    await done
    return
  }

  if (command === 'serve') {
    if (values.stdio) {
      // stdout carries the protocol: nothing else must be written there.
      await createLocalServer(config()).serve(serveStdio())
      return
    }
    if (values.ws) {
      const token = values.token ?? randomBytes(24).toString('base64url')
      const harness = createLocalServer({ ...config(), auth: pairingTokenAuth(token) })
      const listening = await listenWebSocket(
        { port: Number(values.port ?? 7777), host: values.host ?? '127.0.0.1' },
        (transport) => void harness.serve(transport),
      )
      process.stderr.write(
        `wica listening on ws://${values.host ?? '127.0.0.1'}:${listening.port}\npairing token: ${token}\n`,
      )
      return
    }
    throw new ConfigError('serve needs --stdio or --ws.')
  }

  let transport: ClientTransport
  let token: string | undefined
  if (command === 'connect') {
    if (!target) throw new ConfigError('connect needs a ws:// address.')
    transport = connectWebSocket(target)
    token = values.token
  } else if (command === undefined) {
    config() // fails early if the model is not configured
    const self = fileURLToPath(import.meta.url)
    transport = spawnStdio(process.execPath, [
      self,
      'serve',
      '--stdio',
      ...(values.yes ? ['--yes'] : []),
    ])
  } else {
    throw new ConfigError(`unknown command: ${command}\n\n${USAGE}`)
  }

  const client = createClient(transport, {
    from: { channel: 'local' },
    ...(token ? { token } : {}),
  })
  await client.connect()
  const conversationId = values.conversation ?? crypto.randomUUID()
  await client.subscribe(conversationId)
  await runCli(client, conversationId, { input: process.stdin, output: process.stdout })
  await client.close()
  process.exit(0)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`)
  process.exit(1)
})
