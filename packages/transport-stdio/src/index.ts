// stdio transport: JSON frames, one per line, on the streams of a local process. The server
// reads stdin and writes stdout; the client launches the server as a child process.

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

/** Transport over two streams: one JSON frame per line. An unreadable line is ignored. */
export function stdioTransport<Out extends Frame, In extends Frame>(
  input: Readable,
  output: Writable,
): Transport<Out, In> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  // The iterator is born with the transport: readline reads from its creation, and a line that
  // arrived before the first read would otherwise be lost.
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
          // A line that is not a frame: nothing to pass on.
        }
      }
    },
    close: async () => {
      lines.close()
      if (!output.writableEnded) output.end()
    },
  }
}

/** Server side: the client protocol on the stdin and stdout of the process. */
export const serveStdio = (): ServerTransport =>
  stdioTransport<ServerFrame, ClientFrame>(process.stdin, process.stdout)

/** Client side: launches the server and talks with it through its streams; `close` stops it. */
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
