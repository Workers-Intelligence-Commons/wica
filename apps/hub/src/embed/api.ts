// The component's link to its hub: the guest key, the consents and the current conversation, kept
// in the storage of the site that holds the component, and the requests to the hub's guest
// routes. Requests carry no cookie, so a hub account never answers them.

import type { Envelope } from '@wica/protocol'

import type { ConsentId } from '../shared/consent.ts'
import type { EmbedInfo } from '../shared/embed.ts'

export type GuestKey = { id: string; secret: string }

type Saved = {
  key?: GuestKey | undefined
  conversation?: string | undefined
  consents?: Partial<Record<ConsentId, { granted: boolean; at: string }>> | undefined
}

export class HubError extends Error {
  override name = 'HubError'
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function hubApi(hub: URL) {
  const storageKey = `wic-guest-chat:${hub.origin}`
  let fingerprint: string | null = null

  const saved = (): Saved => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Saved
    } catch {
      return {}
    }
  }
  const save = (change: Partial<Saved>) => {
    const next = { ...saved(), ...change }
    for (const k of Object.keys(change) as (keyof Saved)[]) {
      if (change[k] === undefined) delete next[k]
    }
    localStorage.setItem(storageKey, JSON.stringify(next))
  }

  const session = (name: string) => `${storageKey}:${name}`

  function headers(): Record<string, string> {
    const key = saved().key
    return {
      ...(key ? { 'x-wica-guest': `${key.id}.${key.secret}` } : {}),
      ...(fingerprint ? { 'x-wica-fingerprint': fingerprint } : {}),
    }
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, hub), {
      ...init,
      credentials: 'omit',
      headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
    })
    const sessionId = response.headers.get('x-wica-session')
    if (sessionId) sessionStorage.setItem(session('harness'), sessionId)
    const body = (await response.json().catch(() => ({}))) as T & { error?: string; ok?: boolean }
    if (!response.ok || body.ok === false) {
      throw new HubError(body.error ?? `the hub refused (${response.status})`, response.status)
    }
    return body
  }

  return {
    url: (path: string) => new URL(path, hub),
    headers,
    info: () => call<EmbedInfo>('/api/embed'),

    consent: (kind: ConsentId) => saved().consents?.[kind],
    answer(kind: ConsentId, granted: boolean) {
      save({ consents: { ...saved().consents, [kind]: { granted, at: new Date().toISOString() } } })
    },
    grantedConsents: () =>
      Object.entries(saved().consents ?? {})
        .filter(([, answer]) => answer?.granted)
        .map(([kind]) => kind),

    key: () => saved().key,
    conversation: () => saved().conversation,
    setConversation: (id: string | undefined) => save({ conversation: id }),

    /**
     * The fingerprint, computed once after the consent, and a key on the first visit. The library
     * sends nothing anywhere: without an API key it calls no service, and its telemetry is off.
     */
    async start(): Promise<GuestKey> {
      if (!fingerprint) {
        const { Thumbmark } = await import('@thumbmarkjs/thumbmarkjs')
        fingerprint = (await new Thumbmark({ logging: false, collect_beacon: false }).get())
          .thumbmark
      }
      const known = saved().key
      if (known) return known
      const key = await call<GuestKey>('/api/guest', { method: 'POST' })
      save({ key })
      return key
    },

    /** A key the hub no longer knows is forgotten, with its conversation. */
    forget: () => save({ key: undefined, conversation: undefined }),

    createConversation: () =>
      call<{ id: string }>('/api/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),

    liveTicket: (conversationId: string) =>
      call<{ ticket: string }>(`/api/live-ticket/${encodeURIComponent(conversationId)}`, {
        method: 'POST',
      }),

    /** Sends a message after `parentId`, the last item of the conversation. */
    send(conversationId: string, parentId: string | null, text: string) {
      let sessionId = sessionStorage.getItem(session('client'))
      if (!sessionId) {
        sessionId = crypto.randomUUID()
        sessionStorage.setItem(session('client'), sessionId)
      }
      const clientSeq = Number(sessionStorage.getItem(session('seq')) ?? '0') + 1
      sessionStorage.setItem(session('seq'), String(clientSeq))
      const envelope: Envelope = {
        kind: 'command',
        sessionId,
        commandId: crypto.randomUUID(),
        clientSeq,
        conversationId,
        command: { t: 'send', parentId, parts: [{ type: 'text', text }] },
      }
      const harness = sessionStorage.getItem(session('harness'))
      return call<{ ok: true }>('/api/commands', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(harness ? { 'x-wica-session': harness } : {}),
        },
        body: JSON.stringify(envelope),
      })
    },

    /** The hub page that continues the conversation, with the key and the consents handed over. */
    continueUrl() {
      const { key, conversation } = saved()
      const url = new URL(conversation ? `/c/${encodeURIComponent(conversation)}` : '/', hub)
      if (key) {
        const handed = new URLSearchParams({ guest: `${key.id}.${key.secret}` })
        const consents = this.grantedConsents()
        if (consents.length > 0) handed.set('consent', consents.join(','))
        url.hash = handed.toString()
      }
      return url.href
    },
  }
}

export type HubApi = ReturnType<typeof hubApi>
