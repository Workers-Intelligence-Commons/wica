// Internal identifiers sorted by date (UUID v7), and the random salt of a conversation.

export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const time = BigInt(now)
  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Secret salt of a conversation's identifiers: 32 random bytes in base64. */
export const randomSalt = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
