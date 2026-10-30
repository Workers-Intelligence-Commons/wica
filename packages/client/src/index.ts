// Client du protocole (specs/harness.md, Protocole client) : miroir local du journal, envoi des
// commandes et vue dérivée pour l'écran. Le miroir rattrape le serveur, il ne fait jamais foi.
// Ce paquet ne dépend d'aucune bibliothèque de synchronisation, de stockage ou de rendu.

import {
  APPROVAL_TOOL,
  type Item,
  type Origin,
  type Part,
  pathTo,
  settled,
  userMessageId,
} from '@wica/core'
import {
  type ClientFrame,
  type ClientTransport,
  type Command,
  type Envelope,
  PROTOCOL_VERSION,
  type ServerFrame,
} from '@wica/protocol'
import { SAY_TOOL, type SayInput } from '@wica/tools-user'

export type ViewEntry =
  | { type: 'user'; item: Extract<Item, { kind: 'user_message' }> }
  | {
      type: 'assistant'
      item: Extract<Item, { kind: 'assistant_text' }>
      text: string
      streaming: boolean
    }
  | {
      type: 'tool'
      call: Extract<Item, { kind: 'tool_call' }>
      result?: Extract<Item, { kind: 'tool_result' }>
      state: 'running' | 'awaiting_approval' | 'done' | 'error'
      progress?: string
    }
  | { type: 'say'; call: Extract<Item, { kind: 'tool_call' }>; text: string }
  | {
      type: 'question'
      call: Extract<Item, { kind: 'tool_call' }>
      result?: Extract<Item, { kind: 'tool_result' }>
      approval: boolean
    }

export type ConversationView = {
  head: string | null
  entries: ViewEntry[]
  /** Appels du canal utilisateur qui attendent une réponse de la personne. */
  waiting: Extract<Item, { kind: 'tool_call' }>[]
  /**
   * Appels d'outils confiés à ce client par le serveur, une fois autorisés, qui attendent leur
   * résultat (`answer` avec un `ClientToolResult`).
   */
  clientCalls: Extract<Item, { kind: 'tool_call' }>[]
  /**
   * Le journal est au repos : aucun appel n'attend son résultat et rien n'attend de réponse du
   * modèle. Avec `running` faux, le serveur ne doit plus rien à cette conversation.
   */
  settled: boolean
  /** Dernière erreur signalée par le serveur, par exemple un échec du modèle. */
  error?: string
  /** Vrai pendant qu'un tour tourne sur le serveur. */
  running?: boolean
}

type Mirror = {
  salt: string | null
  head: string | null
  items: Map<string, Item>
  live: Map<string, string>
  progress: Map<string, string>
  listeners: Set<() => void>
  /** Dernière erreur signalée par le serveur pour cette conversation. */
  error?: string
  running: boolean
}

export type ClientOptions = {
  /** Provenance de la personne qui utilise ce client, pour calculer l'identifiant de ses messages. */
  from?: Pick<Origin, 'channel' | 'author'>
  token?: string
}

/** Vue pour l'écran, dérivée du miroir sans état propre. */
export function deriveView(
  items: Iterable<Item>,
  head: string | null,
  live = new Map<string, string>(),
  progress = new Map<string, string>(),
): ConversationView {
  const all = [...items].sort((a, b) => a.seq - b.seq)
  const path = pathTo(all, head)
  const results = new Map(
    all.flatMap((i) => (i.kind === 'tool_result' ? [[i.callId, i] as const] : [])),
  )
  const approvals = new Set(
    all.flatMap((i) =>
      i.kind === 'tool_call' && i.tool === APPROVAL_TOOL
        ? [(i.input as { callId: string }).callId]
        : [],
    ),
  )
  const entries: ViewEntry[] = []
  for (const item of path) {
    if (item.kind === 'user_message') entries.push({ type: 'user', item })
    else if (item.kind === 'assistant_text') {
      if (item.audience !== 'user' && item.status !== 'streaming') continue
      const streaming = item.status === 'streaming'
      entries.push({
        type: 'assistant',
        item,
        text: streaming ? (live.get(item.id) ?? item.text) : item.text,
        streaming,
      })
    } else if (item.kind === 'tool_call') {
      const result = results.get(item.callId)
      if (item.channel === 'user' && item.tool === SAY_TOOL) {
        entries.push({ type: 'say', call: item, text: (item.input as SayInput).text ?? '' })
        continue
      }
      if (item.channel === 'user') {
        entries.push({
          type: 'question',
          call: item,
          ...(result ? { result } : {}),
          approval: item.tool === APPROVAL_TOOL,
        })
        continue
      }
      const state = result
        ? result.isError
          ? 'error'
          : 'done'
        : approvals.has(item.callId) && !results.has(`approve:${item.callId}`)
          ? 'awaiting_approval'
          : 'running'
      const p = progress.get(item.callId)
      entries.push({
        type: 'tool',
        call: item,
        ...(result ? { result } : {}),
        state,
        ...(p ? { progress: p } : {}),
      })
    }
  }
  const waiting = path.filter(
    (i): i is Extract<Item, { kind: 'tool_call' }> =>
      i.kind === 'tool_call' &&
      i.channel === 'user' &&
      i.tool !== SAY_TOOL &&
      !results.has(i.callId),
  )
  const handed = new Set(
    all.flatMap((i) =>
      i.kind === 'event' && i.name === 'handed' ? [(i.data as { callId: string }).callId] : [],
    ),
  )
  const clientCalls = path.filter(
    (i): i is Extract<Item, { kind: 'tool_call' }> =>
      i.kind === 'tool_call' &&
      i.channel === 'environment' &&
      handed.has(i.callId) &&
      !results.has(i.callId),
  )
  return { head, entries, waiting, clientCalls, settled: settled(all, head) }
}

export function createClient(transport: ClientTransport, options: ClientOptions = {}) {
  const from = options.from ?? { channel: 'default' }
  const mirrors = new Map<string, Mirror>()
  const acks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
  let sessionId: string | null = null
  let clientSeq = 0
  let welcomed: () => void = () => {}
  let refused: (e: Error) => void = () => {}
  const expectWelcome = () =>
    new Promise<void>((resolve, reject) => {
      welcomed = resolve
      refused = reject
    })
  let welcome = expectWelcome()
  // Un refus sans attente déclarée ne doit pas devenir une promesse rejetée orpheline.
  welcome.catch(() => {})
  /** Commandes sans accusé, renvoyées telles quelles après une reconnexion. */
  const unacked = new Map<string, Envelope>()
  const subscribed = new Set<string>()
  /** Abonnements qui attendent leur première trame `status`, envoyée après l'historique. */
  const syncing = new Map<string, () => void>()
  let hello: ClientFrame | null = null

  const mirror = (conversationId: string): Mirror => {
    let m = mirrors.get(conversationId)
    if (!m) {
      m = {
        salt: null,
        head: null,
        items: new Map(),
        live: new Map(),
        progress: new Map(),
        listeners: new Set(),
        running: false,
      }
      mirrors.set(conversationId, m)
    }
    return m
  }
  const notify = (m: Mirror) => m.listeners.forEach((l) => l())

  const onFrame = (frame: ServerFrame) => {
    switch (frame.kind) {
      case 'welcome':
        sessionId = frame.sessionId
        welcomed()
        return
      case 'items': {
        const m = mirror(frame.conversationId)
        m.salt = frame.salt
        for (const item of frame.items) {
          m.items.set(item.id, item)
          // Le texte enregistré fait foi ; les deltas suivants s'y ajoutent.
          m.live.delete(item.id)
        }
        return notify(m)
      }
      case 'head': {
        const m = mirror(frame.conversationId)
        m.head = frame.itemId
        return notify(m)
      }
      case 'delta': {
        const m = mirror(frame.conversationId)
        const base =
          m.live.get(frame.itemId) ??
          (m.items.get(frame.itemId) as { text?: string } | undefined)?.text ??
          ''
        m.live.set(frame.itemId, base + frame.text)
        return notify(m)
      }
      case 'progress': {
        const m = mirror(frame.conversationId)
        m.progress.set(frame.callId, frame.message)
        return notify(m)
      }
      case 'ack': {
        const waiter = acks.get(frame.commandId)
        acks.delete(frame.commandId)
        unacked.delete(frame.commandId)
        if (!waiter) return
        if (frame.ok) waiter.resolve()
        else waiter.reject(new Error(frame.error))
        return
      }
      case 'error': {
        // Sans conversation : refus de la connexion elle-même (authentification).
        if (!frame.conversationId) return refused(new Error(frame.message))
        const m = mirror(frame.conversationId)
        m.error = frame.message
        return notify(m)
      }
      case 'status': {
        const m = mirror(frame.conversationId)
        syncing.get(frame.conversationId)?.()
        syncing.delete(frame.conversationId)
        m.running = frame.running
        if (frame.running) delete m.error
        return notify(m)
      }
      case 'pong':
        return
    }
  }

  const sendSubscribe = (conversationId: string) =>
    transport.send({ kind: 'subscribe', conversationId, fromSeq: fromSeq(conversationId) })

  /**
   * Curseur de reprise : un élément réglé après coup garde son `seq`, donc la lecture reprend
   * avant le plus ancien élément encore en flux.
   */
  function fromSeq(conversationId: string): number {
    const items = [...mirror(conversationId).items.values()]
    const streaming = items.filter((i) => i.status === 'streaming').map((i) => i.seq)
    if (streaming.length > 0) return Math.min(...streaming) - 1
    return items.reduce((max, i) => Math.max(max, i.seq), 0)
  }

  // Après une reconnexion : nouvelle session, abonnements depuis le curseur, commandes rejouées
  // avec leur identifiant, que le serveur n'exécute qu'une fois.
  transport.onReopen?.(() => {
    if (!hello) return
    welcome = expectWelcome()
    welcome.catch(() => {})
    void (async () => {
      // La session connue est reprise ; perdue côté serveur, il en ouvre une autre sans bruit.
      await transport.send({
        ...(hello as Extract<ClientFrame, { kind: 'hello' }>),
        ...(sessionId ? { sessionId } : {}),
      })
      await welcome
      for (const conversationId of subscribed) await sendSubscribe(conversationId)
      for (const envelope of unacked.values()) {
        await transport.send({ ...envelope, sessionId: sessionId as string })
      }
    })().catch(() => {})
  })

  const reading = (async () => {
    for await (const frame of transport.receive()) onFrame(frame)
  })()

  async function command(conversationId: string, cmd: Command): Promise<void> {
    await welcome
    const commandId = crypto.randomUUID()
    const done = new Promise<void>((resolve, reject) => acks.set(commandId, { resolve, reject }))
    const envelope: Envelope = {
      kind: 'command',
      sessionId: sessionId as string,
      commandId,
      clientSeq: ++clientSeq,
      conversationId,
      command: cmd,
    }
    unacked.set(commandId, envelope)
    await transport.send(envelope)
    return done
  }

  return {
    async connect() {
      hello = {
        kind: 'hello',
        version: PROTOCOL_VERSION,
        ...(options.token ? { token: options.token } : {}),
      }
      await transport.send(hello)
      await welcome
    },

    fromSeq,

    /** S'abonne et rend la main une fois l'historique reçu (le serveur envoie ensuite `status`). */
    async subscribe(conversationId: string) {
      await welcome
      subscribed.add(conversationId)
      const synced = new Promise<void>((resolve) => syncing.set(conversationId, resolve))
      await sendSubscribe(conversationId)
      await synced
    },

    view(conversationId: string): ConversationView {
      const m = mirror(conversationId)
      return {
        ...deriveView(m.items.values(), m.head, m.live, m.progress),
        ...(m.error !== undefined ? { error: m.error } : {}),
        running: m.running,
      }
    },

    onChange(conversationId: string, listener: () => void): () => void {
      const m = mirror(conversationId)
      m.listeners.add(listener)
      return () => m.listeners.delete(listener)
    },

    /** Envoie un message et rend son identifiant, calculé comme le fera le serveur. */
    async send(
      conversationId: string,
      parts: Part[] | string,
      parentId?: string | null,
    ): Promise<string | null> {
      const m = mirror(conversationId)
      const content: Part[] = typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts
      const parent = parentId !== undefined ? parentId : m.head
      await command(conversationId, { t: 'send', parentId: parent, parts: content })
      return m.salt === null
        ? null
        : userMessageId({ salt: m.salt, conversationId, parentId: parent, from, parts: content })
    },

    answer: (conversationId: string, callId: string, value: unknown) =>
      command(conversationId, { t: 'answer', callId, value }),
    interrupt: (conversationId: string) => command(conversationId, { t: 'interrupt' }),
    setHead: (conversationId: string, itemId: string) =>
      command(conversationId, { t: 'set_head', itemId }),
    regenerate: (conversationId: string, itemId: string) =>
      command(conversationId, { t: 'regenerate', itemId }),

    async close() {
      await transport.close()
      await reading
    },
  }
}

export type Client = ReturnType<typeof createClient>
