// A person without an account, on an instance that accepts guests. Their key and their answers to
// the kinds of consent stay in this browser's localStorage, and every request to the API carries
// the key, with the fingerprint of the browser that counts their daily messages. The key exists
// only once the person agrees to the fingerprint; signing in hands its conversations to the account.

import type { ConsentId } from '../shared/consent.ts'

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
 * After a sign-in, the guest's conversations become the account's. The key is forgotten once the
 * server took them, or when it no longer knows the key.
 */
export async function claimGuest() {
  const key = guestKey()
  if (!key) return
  const response = await fetch('/api/guest/claim', {
    method: 'POST',
    headers: { 'x-wica-guest': `${key.id}.${key.secret}` },
  })
  if (response.ok || response.status === 404) localStorage.removeItem(KEY)
}
