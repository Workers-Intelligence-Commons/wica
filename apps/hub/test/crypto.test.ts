import { describe, expect, it } from 'vite-plus/test'

import { decrypt, encrypt, instanceKey, sign, verify } from '../src/server/crypto.ts'

const keyOf = (byte: number) => instanceKey(Buffer.alloc(32, byte).toString('base64'))

describe('encryption of model tokens', () => {
  it('returns the token encrypted with the instance key', async () => {
    const key = await keyOf(1)
    const sealed = await encrypt(key, 'sk-secret')
    expect(sealed.ciphertext).not.toContain('sk-secret')
    expect(await decrypt(key, sealed)).toBe('sk-secret')
  })

  it('refuses modified content or another key', async () => {
    const key = await keyOf(1)
    const sealed = await encrypt(key, 'sk-secret')
    // A middle character carries 6 bits of data; the last one may carry only padding.
    const middle = Math.floor(sealed.ciphertext.length / 2)
    const flipped = sealed.ciphertext[middle] === 'A' ? 'B' : 'A'
    const tampered = {
      ...sealed,
      ciphertext:
        sealed.ciphertext.slice(0, middle) + flipped + sealed.ciphertext.slice(middle + 1),
    }
    await expect(decrypt(key, tampered)).rejects.toThrow()
    await expect(decrypt(await keyOf(2), sealed)).rejects.toThrow()
  })
})

describe('signed values', () => {
  it('returns the signed value and refuses a modified signature', async () => {
    const signed = await sign('secret', { uid: 'u1' })
    expect(await verify('secret', signed)).toEqual({ uid: 'u1' })
    expect(await verify('other', signed)).toBeNull()
    expect(await verify('secret', `${signed}x`)).toBeNull()
  })
})
