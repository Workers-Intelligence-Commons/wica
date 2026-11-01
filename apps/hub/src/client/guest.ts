// A person without an account, on an instance that accepts guests. Their key and their answers to
// the kinds of consent stay in this browser's localStorage, and every request to the API carries
// the key, with the fingerprint of the browser that counts their daily messages. The key exists
// only once the person agrees to the fingerprint; signing in hands its conversations to the account.
// The guest chat component on another site hands its key over in the address (`#guest=`).

import { type ConsentId, isConsentId } from '../shared/consent.ts'

const KEY = 'wica-guest'
const CONSENTS = 'wica-consents'

export type GuestKey = { id: string; secret: string }
export type ConsentAnswer = { granted: boolean; at: string }

const read = <T>(name: string): T | null => {
  try {
    const text = localStorage.getItem(name)
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

export const guestKey = () => read<GuestKey>(KEY)

/** The author of a guest's messages, as the server names it. */
export const guestAccount = (key: GuestKey) => `guest:${key.id}`

export const guestConsents = () => read<Record<string, ConsentAnswer>>(CONSENTS) ?? {}

export function answerConsent(kind: ConsentId, granted: boolean) {
  const answers = { ...guestConsents(), [kind]: { granted, at: new Date().toISOString() } }
  localStorage.setItem(CONSENTS, JSON.stringify(answers))
}

let fingerprint: string | null = null

/**
 * Computes the fingerprint once, after the consent. The library sends nothing anywhere: without an
 * API key it calls no service, and its sampled telemetry is off.
 */
async function computeFingerprint() {
  if (fingerprint) return fingerprint
  const { Thumbmark } = await import('@thumbmarkjs/thumbmarkjs')
  const result = await new Thumbmark({ logging: false, collect_beacon: false }).get()
  fingerprint = result.thumbmark
  return fingerprint
}

/**
 * Makes the guest ready to send requests: the fingerprint, and a key created on the first visit.
 * `null` until the person agrees to the protection consent.
 */
export async function startGuest(): Promise<GuestKey | null> {
  if (!guestConsents().protection?.granted) return null
  await computeFingerprint()
  const known = guestKey()
  if (known) return known
  const response = await fetch('/api/guest', { method: 'POST' })
  if (!response.ok) throw new Error(`guest key refused (${response.status})`)
  const key = (await response.json()) as GuestKey
  localStorage.setItem(KEY, JSON.stringify(key))
  return key
}

/** Headers of a guest's request; none for an account. */
export function guestHeaders(): Record<string, string> {
  const key = guestKey()
  if (!key) return {}
  return {
    'x-wica-guest': `${key.id}.${key.secret}`,
    ...(fingerprint ? { 'x-wica-fingerprint': fingerprint } : {}),
  }
}

/** `fetch` for the API: a guest's request carries their key. */
export const apiFetch = (input: string, init: RequestInit = {}) =>
  fetch(input, {
    ...init,
    headers: { ...guestHeaders(), ...(init.headers as Record<string, string> | undefined) },
  })

/**
 * After a sign-in, the guest's conversations become the account's. The key kept in this browser
 * is forgotten once the server took them, or when it no longer knows the key.
 */
export async function claimGuest(key = guestKey()) {
  if (!key) return
  const response = await fetch('/api/guest/claim', {
    method: 'POST',
    headers: { 'x-wica-guest': `${key.id}.${key.secret}` },
  })
  const kept = guestKey()
  if ((response.ok || response.status === 404) && kept?.id === key.id) localStorage.removeItem(KEY)
}

/**
 * A key handed over by the guest chat component on another site, whose storage this site cannot
 * read: the account signed in takes its conversations, a guest without a key adopts it, and a
 * guest with another key receives its conversations. The key leaves the address at once; the
 * consents given in the component come with it.
 */
export async function acceptHandOff(signedIn: boolean) {
  const params = new URLSearchParams(location.hash.slice(1))
  const handed = params.get('guest')
  if (!handed) return
  const consents = params.get('consent')?.split(',') ?? []
  params.delete('guest')
  params.delete('consent')
  const rest = params.toString()
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`,
  )
  const [id, secret] = handed.split('.')
  if (!id || !secret) return
  for (const kind of consents) if (isConsentId(kind)) answerConsent(kind, true)
  if (signedIn) return claimGuest({ id, secret })
  const known = guestKey()
  if (!known) return localStorage.setItem(KEY, JSON.stringify({ id, secret }))
  if (known.id === id) return
  await fetch('/api/guest/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wica-guest': `${known.id}.${known.secret}` },
    body: JSON.stringify({ key: handed }),
  })
}
