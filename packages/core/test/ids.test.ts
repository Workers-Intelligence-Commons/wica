import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'

import { canonicalJson, serverItemId, sha256, userMessageId } from '../src/index.ts'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('sha256', () => {
  // Reference values from FIPS 180-4: the client and the server must get the same bytes.
  it('gives the reference hashes', () => {
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

  it('matches the Node implementation for every size around the blocks', () => {
    for (let n = 0; n < 200; n++) {
      const data = new Uint8Array(randomBytes(n))
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })
})

describe('canonicalJson', () => {
  it('does not depend on key order and omits absent properties', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'é'], c: undefined })).toBe(
      canonicalJson({ a: [true, null, 'é'], b: 1 }),
    )
    expect(canonicalJson({ b: 1, a: { d: 2.5, c: 'x' } })).toBe('{"a":{"c":"x","d":2.5},"b":1}')
  })
})

describe('userMessageId', () => {
  const base = {
    salt: 'salt-1',
    conversationId: 'conv-1',
    parentId: 'parent-1',
    from: { channel: 'web', author: 'alice' },
    parts: [{ type: 'text' as const, text: 'yes' }],
  }

  it('is the same for the client and the server, and it is a UUID v8', () => {
    const id = userMessageId(base)
    expect(userMessageId(structuredClone(base))).toBe(id)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('distinguishes authors, parents, contents and salts', () => {
    const id = userMessageId(base)
    expect(userMessageId({ ...base, from: { channel: 'web', author: 'bob' } })).not.toBe(id)
    expect(userMessageId({ ...base, parentId: null })).not.toBe(id)
    expect(userMessageId({ ...base, parts: [{ type: 'text', text: 'no' }] })).not.toBe(id)
    expect(userMessageId({ ...base, salt: 'salt-2' })).not.toBe(id)
  })

  // Clients that know no levels compute the identifiers of their messages without one: a level
  // must change the identifier only when it is chosen.
  it('changes with a chosen reasoning level, and only then', () => {
    const id = userMessageId(base)
    // Computed by the code from before levels existed.
    expect(id).toBe('d0ffff2b-cc0b-84c6-a5f8-48bdbbd894c6')
    expect(userMessageId({ ...base, reasoning: 'high' })).not.toBe(id)
    expect(userMessageId({ ...base, reasoning: 'high' })).not.toBe(
      userMessageId({ ...base, reasoning: 'low' }),
    )
  })

  it('takes a file by its hash, not by its address', () => {
    const file = (uri: string) => ({
      ...base,
      parts: [{ type: 'file' as const, uri, mediaType: 'image/png', sha256: 'abc' }],
    })
    expect(userMessageId(file('blob://a'))).toBe(userMessageId(file('https://b/x.png')))
  })
})

describe('serverItemId', () => {
  it('distinguishes the rank and the triggering input', () => {
    const base = { conversationId: 'c', parentId: 'p', trigger: 't', rank: 0 }
    const id = serverItemId(base)
    expect(serverItemId({ ...base })).toBe(id)
    expect(serverItemId({ ...base, rank: 1 })).not.toBe(id)
    expect(serverItemId({ ...base, trigger: 'u' })).not.toBe(id)
  })
})
