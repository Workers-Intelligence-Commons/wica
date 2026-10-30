import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'

import { canonicalJson, serverItemId, sha256, userMessageId } from '../src/index.ts'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('sha256', () => {
  // Valeurs de référence de la FIPS 180-4 : le client et le serveur doivent obtenir les mêmes octets.
  it('donne les empreintes de référence', () => {
    const enc = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'))
    expect(hex(sha256(enc('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(hex(sha256(enc('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(hex(sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it("concorde avec l'implémentation de Node sur toutes les tailles autour des blocs", () => {
    for (let n = 0; n < 200; n++) {
      const data = new Uint8Array(randomBytes(n))
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })
})

describe('canonicalJson', () => {
  it("ne dépend pas de l'ordre des clés et omet les propriétés absentes", () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'é'], c: undefined })).toBe(
      canonicalJson({ a: [true, null, 'é'], b: 1 }),
    )
    expect(canonicalJson({ b: 1, a: { d: 2.5, c: 'x' } })).toBe('{"a":{"c":"x","d":2.5},"b":1}')
  })
})

describe('userMessageId', () => {
  const base = {
    salt: 'sel-1',
    conversationId: 'conv-1',
    parentId: 'parent-1',
    from: { channel: 'web', author: 'alice' },
    parts: [{ type: 'text' as const, text: 'oui' }],
  }

  it("est le même pour le client et le serveur, et c'est un UUID v8", () => {
    const id = userMessageId(base)
    expect(userMessageId(structuredClone(base))).toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('distingue les auteurs, les parents, les contenus et les sels', () => {
    const id = userMessageId(base)
    expect(userMessageId({ ...base, from: { channel: 'web', author: 'bob' } })).not.toBe(id)
    expect(userMessageId({ ...base, parentId: null })).not.toBe(id)
    expect(userMessageId({ ...base, parts: [{ type: 'text', text: 'non' }] })).not.toBe(id)
    expect(userMessageId({ ...base, salt: 'sel-2' })).not.toBe(id)
  })

  it('prend un fichier par son empreinte, pas par son adresse', () => {
    const file = (uri: string) => ({
      ...base,
      parts: [{ type: 'file' as const, uri, mediaType: 'image/png', sha256: 'abc' }],
    })
    expect(userMessageId(file('blob://a'))).toBe(userMessageId(file('https://b/x.png')))
  })
})

describe('serverItemId', () => {
  it("distingue le rang et l'entrée déclencheuse", () => {
    const base = { conversationId: 'c', parentId: 'p', trigger: 't', rank: 0 }
    const id = serverItemId(base)
    expect(serverItemId({ ...base })).toBe(id)
    expect(serverItemId({ ...base, rank: 1 })).not.toBe(id)
    expect(serverItemId({ ...base, trigger: 'u' })).not.toBe(id)
  })
})
