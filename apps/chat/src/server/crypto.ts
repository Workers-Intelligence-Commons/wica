// Chiffrement des jetons de modèle (AES-GCM, clé de l'instance), signature des cookies de
// session (HMAC-SHA-256) et empreintes des clés d'API et des jetons de serveur. Tout passe par
// WebCrypto, présent sur Node comme sur Workers.

export type InstanceKey = { id: string; key: CryptoKey }

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const fromBase64Url = (text: string) => {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/')
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  )
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Jeton aléatoire de 32 octets, avec un préfixe qui dit ce qu'il ouvre. */
export const randomToken = (prefix: string) =>
  `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`

/** Clé de l'instance, donnée en base64 (32 octets) ; son identifiant suit une rotation. */
export async function instanceKey(base64: string): Promise<InstanceKey> {
  const raw = fromBase64Url(base64.trim())
  if (raw.length !== 32) throw new Error('La clé de l’instance doit faire 32 octets en base64.')
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id: (await sha256Hex(base64.trim())).slice(0, 16), key }
}

export async function encrypt(key: InstanceKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.key, encoder.encode(plaintext)),
  )
  return { ciphertext: `${toBase64Url(iv)}.${toBase64Url(sealed)}`, key_id: key.id }
}

export async function decrypt(key: InstanceKey, sealed: { ciphertext: string; key_id: string }) {
  if (sealed.key_id !== key.id) throw new Error('Jeton chiffré avec une autre clé de l’instance.')
  const [iv = '', data = ''] = sealed.ciphertext.split('.')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv) },
    key.key,
    fromBase64Url(data),
  )
  return new TextDecoder().decode(plain)
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])

/** Valeur signée : `données.signature`, en base64url. */
export async function sign(secret: string, value: unknown): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(value)))
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body)),
  )
  return `${body}.${toBase64Url(mac)}`
}

/** La valeur d'origine, ou `null` si la signature ne correspond pas ; la comparaison est celle de WebCrypto. */
export async function verify<T>(secret: string, signed: string): Promise<T | null> {
  const [body, mac] = signed.split('.')
  if (!body || !mac) return null
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    fromBase64Url(mac),
    encoder.encode(body),
  )
  if (!ok) return null
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T
  } catch {
    return null
  }
}

export { fromBase64Url, toBase64Url }
