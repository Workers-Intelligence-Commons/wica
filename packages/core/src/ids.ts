// Identifiants déterministes des éléments.
// Le client et le serveur exécutent ce même code : un écart d'un seul octet dans la
// sérialisation donnerait deux identifiants différents pour le même message.

import type { Origin, Part } from './journal.ts'

/**
 * Sérialisation canonique : clés d'objet triées par unités de code UTF-16, nombres et
 * chaînes écrits comme `JSON.stringify`, propriétés `undefined` omises (règles de la RFC 8785).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson : nombre non fini')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
    }
    default:
      throw new TypeError(`canonicalJson : type non sérialisable (${typeof value})`)
  }
}

// `core` n'a ni dépendance ni API de plateforme : l'encodage UTF-8 et SHA-256 sont écrits ici.
function utf8(text: string): Uint8Array {
  const out: number[] = []
  for (const char of text) {
    const c = char.codePointAt(0) as number
    if (c >= 0xd800 && c <= 0xdfff) throw new TypeError('utf8 : demi-paire UTF-16 isolée')
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number
      const b = w[i - 2] as number
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] as number) + a
    h[1] = (h[1] as number) + b
    h[2] = (h[2] as number) + c
    h[3] = (h[3] as number) + d
    h[4] = (h[4] as number) + e
    h[5] = (h[5] as number) + f
    h[6] = (h[6] as number) + g
    h[7] = (h[7] as number) + hh
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number)
  return out
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** UUID v8 (RFC 9562) tiré des 16 premiers octets du SHA-256 de la sérialisation canonique. */
export function deterministicUuid(value: unknown): string {
  const bytes = sha256(utf8(canonicalJson(value))).slice(0, 16)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const h = hex(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export type UserMessageIdInput = {
  salt: string
  conversationId: string
  parentId: string | null
  from: Pick<Origin, 'channel' | 'author'>
  parts: Part[]
}

/** Identifiant d'un `user_message`, calculé à l'identique par le client et le serveur. */
export function userMessageId(input: UserMessageIdInput): string {
  return deterministicUuid([
    'wica/user_message/1',
    input.salt,
    input.conversationId,
    input.parentId,
    input.from.channel,
    input.from.author ?? null,
    // Un fichier entre par son empreinte : la même donnée sous deux adresses reste le même message.
    input.parts.map((p) => (p.type === 'file' ? { type: 'file', sha256: p.sha256 } : p)),
  ])
}

export type ServerItemIdInput = {
  conversationId: string
  parentId: string | null
  /** Identifiant de l'entrée qui a déclenché la production : élément auquel il répond, ou commande. */
  trigger: string
  /** Rang parmi les éléments produits pour cette entrée, fixé par elle et jamais recompté. */
  rank: number
}

/** Identifiant d'un élément produit par le serveur, connu avant que son contenu existe. */
export function serverItemId(input: ServerItemIdInput): string {
  return deterministicUuid([
    'wica/server_item/1',
    input.conversationId,
    input.parentId,
    input.trigger,
    input.rank,
  ])
}
