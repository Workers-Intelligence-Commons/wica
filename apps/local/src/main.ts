#!/usr/bin/env node
// Binaire local autonome (topologie « tout local ») :
//   wica                          client en ligne de commande, serveur lancé par stdio
//   wica serve --stdio            sert le protocole client sur stdin et stdout
//   wica serve --ws [--port N] [--host H] [--token T]
//   wica connect <url> --token T  client vers un serveur WebSocket
//   wica acp                      agent pour un éditeur, par l'Agent Client Protocol sur stdio

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
import { ConfigError, configFromEnv, createLocalServer } from './server.ts'

const USAGE = `Utilisation :
  wica [--yes] [--conversation ID]
  wica serve --stdio [--yes]
  wica serve --ws [--port 7777] [--host 127.0.0.1] [--token JETON] [--yes]
  wica connect ws://hôte:port --token JETON [--conversation ID]
  wica acp [--yes]

Modèle : WICA_MODEL_URL, WICA_MODEL, WICA_API_KEY (facultatif), WICA_REASONING_EFFORT (facultatif).
--yes autorise tous les outils sans demander ; sinon toute action qui n'est pas une lecture demande l'accord.`

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
    // stdout porte ACP : rien d'autre ne doit y être écrit.
    await serveAcp(config())
    return
  }

  if (command === 'serve') {
    if (values.stdio) {
      // stdout porte le protocole : rien d'autre ne doit y être écrit.
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
        `wica écoute sur ws://${values.host ?? '127.0.0.1'}:${listening.port}\njeton d'appairage : ${token}\n`,
      )
      return
    }
    throw new ConfigError('serve demande --stdio ou --ws.')
  }

  let transport: ClientTransport
  let token: string | undefined
  if (command === 'connect') {
    if (!target) throw new ConfigError('connect demande une adresse ws://.')
    transport = connectWebSocket(target)
    token = values.token
  } else if (command === undefined) {
    config() // échoue tôt si le modèle n'est pas configuré
    const self = fileURLToPath(import.meta.url)
    transport = spawnStdio(process.execPath, [
      self,
      'serve',
      '--stdio',
      ...(values.yes ? ['--yes'] : []),
    ])
  } else {
    throw new ConfigError(`commande inconnue : ${command}\n\n${USAGE}`)
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
