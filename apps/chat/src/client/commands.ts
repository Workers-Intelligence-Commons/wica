// Commandes du navigateur : enveloppes du protocole client envoyées par `POST /api/commands`.
// Un message s'affiche tout de suite (insertion optimiste avec l'identifiant que le serveur
// calculera), puis il est confirmé quand sa ligne revient par la synchro, ou annulé si l'API le
// refuse. L'écriture ne passe jamais par Electric.

import { createTransaction } from '@tanstack/react-db'
import { isChangeMessage } from '@tanstack/electric-db-collection'
import { type Part, userMessageId } from '@wica/core'
import type { Command, Envelope } from '@wica/protocol'

import { markPending } from './cache.ts'
import type { ItemShapeRow } from './collections.ts'

/** Attente de la confirmation par la synchro, au-delà de laquelle l'envoi est annulé. */
const CONFIRM_TIMEOUT_MS = 30_000

export class CommandError extends Error {
  override name = 'CommandError'
}

const tabState = () => {
  const read = (key: string) => sessionStorage.getItem(`wica-${key}`)
  const write = (key: string, value: string) => sessionStorage.setItem(`wica-${key}`, value)
  let sessionId = read('client-session')
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    write('client-session', sessionId)
  }
  return {
    sessionId,
    nextSeq() {
      const seq = Number(read('client-seq') ?? '0') + 1
      write('client-seq', String(seq))
      return seq
    },
    harnessSession: () => read('harness-session'),
    setHarnessSession: (id: string) => write('harness-session', id),
  }
}

let tab: ReturnType<typeof tabState> | null = null

/** Enveloppe d'une commande, numérotée dans l'ordre de cet onglet. */
export function envelope(
  conversationId: string,
  command: Command,
  commandId = crypto.randomUUID(),
): Envelope {
  tab ??= tabState()
  return {
    kind: 'command',
    sessionId: tab.sessionId,
    commandId,
    clientSeq: tab.nextSeq(),
    conversationId,
    command,
  }
}

/** Envoie une enveloppe ; un rejeu du même `commandId` rend la même réponse. */
export async function postCommand(env: Envelope): Promise<{ ok: boolean; deposited?: boolean }> {
  tab ??= tabState()
  const harness = tab.harnessSession()
  const response = await fetch('/api/commands', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(harness ? { 'x-wica-session': harness } : {}),
    },
    body: JSON.stringify(env),
  })
  const session = response.headers.get('x-wica-session')
  if (session) tab.setHarnessSession(session)
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
    deposited?: boolean
  }
  if (!response.ok || body.ok === false) {
    throw new CommandError(body.error ?? `command refused (${response.status})`)
  }
  return { ok: true, ...(body.deposited ? { deposited: true } : {}) }
}

export const command = (conversationId: string, cmd: Command) =>
  postCommand(envelope(conversationId, cmd))

type AwaitMatch = (
  fn: (message: Parameters<typeof isChangeMessage>[0]) => boolean,
  timeout?: number,
) => Promise<boolean>

/** Collection des éléments ; `awaitMatch` vient de la collection Electric du navigateur. */
type ItemsCollection = {
  insert(row: ItemShapeRow): unknown
  utils: Record<string, unknown>
}

/**
 * Envoie un message : ligne optimiste dans la collection, commande, puis attente de la ligne
 * écrite par le serveur. Rend l'identifiant du message.
 */
export async function sendMessage(options: {
  items: ItemsCollection
  account: string
  conversationId: string
  salt: string
  parentId: string | null
  parts: Part[]
  /** `seq` provisoire, après le dernier élément connu. */
  seq: number
}): Promise<string> {
  const from = { channel: 'web', author: options.account }
  const id = userMessageId({
    salt: options.salt,
    conversationId: options.conversationId,
    parentId: options.parentId,
    from,
    parts: options.parts,
  })
  const env = envelope(options.conversationId, {
    t: 'send',
    parentId: options.parentId,
    parts: options.parts,
  })
  const awaitMatch = options.items.utils['awaitMatch'] as AwaitMatch | undefined
  if (!awaitMatch)
    throw new CommandError('this collection has no sync, so the message cannot be sent')
  markPending(options.account, options.conversationId, true)
  const tx = createTransaction({
    mutationFn: async () => {
      try {
        await postCommand(env)
        const seen = await awaitMatch(
          (message) => isChangeMessage(message) && (message.value as { id?: string }).id === id,
          CONFIRM_TIMEOUT_MS,
        )
        if (!seen) throw new CommandError('the sync did not confirm the message')
      } finally {
        markPending(options.account, options.conversationId, false)
      }
    },
  })
  tx.mutate(() => {
    options.items.insert({
      conversation_id: options.conversationId,
      id,
      parent_id: options.parentId,
      seq: options.seq,
      kind: 'user_message',
      status: 'done',
      payload: {
        id,
        parentId: options.parentId,
        at: new Date().toISOString(),
        kind: 'user_message',
        parts: options.parts,
        from: { ...from, trust: 'owner' },
      },
    })
  })
  await tx.when('settled')
  return id
}
