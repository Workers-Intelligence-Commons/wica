import { describe, expect, it } from 'vite-plus/test'

import { decrypt, encrypt, instanceKey, sign, verify } from '../src/server/crypto.ts'

const keyOf = (byte: number) => instanceKey(Buffer.alloc(32, byte).toString('base64'))

describe('chiffrement des jetons de modèle', () => {
  it('rend le jeton chiffré avec la clé de l’instance', async () => {
    const key = await keyOf(1)
    const sealed = await encrypt(key, 'sk-secret')
    expect(sealed.ciphertext).not.toContain('sk-secret')
    expect(await decrypt(key, sealed)).toBe('sk-secret')
  })

  it('refuse un contenu modifié ou une autre clé', async () => {
    const key = await keyOf(1)
    const sealed = await encrypt(key, 'sk-secret')
    // Un caractère du milieu porte 6 bits de données ; le dernier peut ne porter que du remplissage.
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

describe('valeurs signées', () => {
  it('rend la valeur signée et refuse une signature modifiée', async () => {
    const signed = await sign('secret', { uid: 'u1' })
    expect(await verify('secret', signed)).toEqual({ uid: 'u1' })
    expect(await verify('autre', signed)).toBeNull()
    expect(await verify('secret', `${signed}x`)).toBeNull()
  })
})
