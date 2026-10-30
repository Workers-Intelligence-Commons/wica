// Transport stdio : des trames JSON, une par ligne, sur
// les flux d'un processus local. Le serveur lit stdin et écrit stdout ; le client lance le
// serveur comme processus enfant.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import type {
  ClientFrame,
  ClientTransport,
  Frame,
  ServerFrame,
  ServerTransport,
  Transport,
} from '@wica/protocol'

/** Transport sur deux flux : une trame JSON par ligne. Une ligne illisible est ignorée. */
export function stdioTransport<Out extends Frame, In extends Frame>(
  input: Readable,
  output: Writable,
): Transport<Out, In> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  // L'itérateur naît avec le transport : readline lit dès sa création, et une ligne arrivée
  // avant la première lecture serait sinon perdue.
  const pending = lines[Symbol.asyncIterator]()
  return {
    send: (frame) =>
      new Promise<void>((resolve) => {
        if (output.writableEnded || output.destroyed) return resolve()
        output.write(`${JSON.stringify(frame)}\n`, () => resolve())
      }),
    async *receive() {
      for (;;) {
        const next = await pending.next()
        if (next.done) return
        const line = next.value
        if (line.trim() === '') continue
        try {
          yield JSON.parse(line) as In
        } catch {
          // Ligne qui n'est pas une trame : rien à transmettre.
        }
      }
    },
    close: async () => {
      lines.close()
      if (!output.writableEnded) output.end()
    },
  }
}

/** Côté serveur : le protocole client sur stdin et stdout du processus. */
export const serveStdio = (): ServerTransport =>
  stdioTransport<ServerFrame, ClientFrame>(process.stdin, process.stdout)

/** Côté client : lance le serveur et parle avec lui par ses flux ; `close` l'arrête. */
export function spawnStdio(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ClientTransport {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  })
  const transport = stdioTransport<ClientFrame, ServerFrame>(child.stdout, child.stdin)
  return {
    ...transport,
    close: async () => {
      await transport.close()
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill()
        })
      }
    },
  }
}
