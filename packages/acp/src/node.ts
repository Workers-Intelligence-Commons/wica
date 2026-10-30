// Point d'entrée Node : l'agent ACP parle à l'éditeur par l'entrée et la sortie standard.

import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

/** Flux ACP sur l'entrée et la sortie standard du processus, que l'éditeur a lancé. */
export function stdioStream(): acp.Stream {
  return acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
}
