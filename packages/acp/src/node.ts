// Node entry point: the ACP agent talks to the editor over standard input and output.

import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

/** ACP stream over the standard input and output of the process, which the editor launched. */
export function stdioStream(): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
}
