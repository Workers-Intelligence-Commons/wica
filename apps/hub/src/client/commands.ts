// Browser commands: client protocol envelopes sent through `POST /api/commands`. A message shows
// up right away (optimistic insertion with the identifier the server will compute), then it is
// confirmed when its row comes back through the sync, or cancelled if the API refuses it.
// Writing never goes through the sync.

import { createTransaction } from '@tanstack/react-db'
import { type Part, type ReasoningLevel, userMessageId } from '@wica/core'
import type { Command, Envelope } from '@wica/protocol'

import { markPending } from './cache.ts'
import type { ItemShapeRow } from '../shared/rows.ts'
import { refreshList, rowConfirmation } from './sync/index.ts'

/** Wait for confirmation through the sync, beyond which the send is cancelled. */
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

/** Envelope of a command, numbered in the order of this tab. */
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

/** Sends an envelope; a replay of the same `commandId` returns the same response. */
export async function postCommand(env: Envelope): Promise<{ ok: true }> {
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
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!response.ok || body.ok === false) {
    throw new CommandError(body.error ?? `command refused (${response.status})`)
  }
  return { ok: true }
}

export const command = (conversationId: string, cmd: Command) =>
  postCommand(envelope(conversationId, cmd))

/** Collection of items; its sync gives the confirmation of the rows the server writes. */
type ItemsCollection = {
  insert(row: ItemShapeRow): unknown
  utils: Record<string, unknown>
}

/**
 * Sends a message: optimistic row in the collection, command, then wait for the row written by
 * the server. Returns the message identifier.
 */
export async function sendMessage(options: {
  items: ItemsCollection
  account: string
  conversationId: string
  salt: string
  parentId: string | null
  parts: Part[]
  /** Level chosen for the answer; absent, the provider decides. */
  reasoning?: ReasoningLevel | null
  /** Provisional `seq`, after the last known item. */
  seq: number
}): Promise<string> {
  const from = { channel: 'web', author: options.account }
  const level = options.reasoning ? { reasoning: options.reasoning } : {}
  const id = userMessageId({
    salt: options.salt,
    conversationId: options.conversationId,
    parentId: options.parentId,
    from,
    parts: options.parts,
    ...level,
  })
  const env = envelope(options.conversationId, {
    t: 'send',
    parentId: options.parentId,
    parts: options.parts,
    ...level,
  })
  const confirm = rowConfirmation(options.items, options.conversationId)
  if (!confirm) throw new CommandError('this collection has no sync, so the message cannot be sent')
  markPending(options.account, options.conversationId, true)
  const tx = createTransaction({
    mutationFn: async () => {
      try {
        await postCommand(env)
        const seen = await confirm(id, CONFIRM_TIMEOUT_MS)
        if (!seen) throw new CommandError('the sync did not confirm the message')
        // The first message titles the conversation, which the list shows.
        refreshList()
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
        ...level,
      },
    })
  })
  await tx.when('settled')
  return id
}
