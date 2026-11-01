import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { beforeAll, describe, expect, it } from 'vite-plus/test'

import {
  appAuth,
  type ExternalProfile,
  hashKey,
  type IdentityRepo,
  oidcAuth,
  type Principal,
  sessionCookie,
} from '../src/server/identity.ts'

/** In-memory identity repository: accounts linked by (provider, subject), memberships tracked. */
class MemoryRepo implements IdentityRepo {
  readonly links = new Map<string, string>()
  readonly memberships = new Map<string, string[]>()
  readonly keys = new Map<string, Principal>()
  async principal(userId: string): Promise<Principal | null> {
    const orgs = (this.memberships.get(userId) ?? []).map((id) => ({ id, roles: [] }))
    return { id: userId, kind: 'user', orgs, scopes: [] }
  }
  async apiKey(hash: string) {
    return this.keys.get(hash) ?? null
  }
  async link(profile: ExternalProfile) {
    const key = `${profile.provider}|${profile.subject}`
    const userId = this.links.get(key) ?? `u${this.links.size + 1}`
    this.links.set(key, userId)
    if (profile.orgs)
      this.memberships.set(
        userId,
        profile.orgs.map((o) => o.name),
      )
    return userId
  }
}

const ISSUER = 'https://idp.test'
const AUDIENCE = 'wica-hub'
let privateKey: CryptoKey
let keys: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'ES256' }] })
})

const token = (
  claims: JWTPayload,
  options: { exp?: string | number; iss?: string; aud?: string } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? AUDIENCE)
    .setSubject('alice')
    .setExpirationTime(options.exp ?? '5m')
    .sign(privateKey)

const bearer = (value: string) =>
  new Request('https://hub.test/', { headers: { authorization: `Bearer ${value}` } })

describe('OIDC adapter', () => {
  const setup = () => {
    const repo = new MemoryRepo()
    return {
      repo,
      auth: oidcAuth(repo, { issuer: ISSUER, audience: AUDIENCE, keys, orgsClaim: 'orgs' }),
    }
  }

  it('links a valid token to the same internal account at each login', async () => {
    const { auth } = setup()
    const first = await auth.authenticate(bearer(await token({ orgs: ['lab'] })))
    const second = await auth.authenticate(bearer(await token({ orgs: ['lab'] })))
    expect(first).toMatchObject({ id: 'u1', kind: 'user', orgs: [{ id: 'lab' }] })
    expect(second?.id).toBe('u1')
  })

  // Memberships follow the claims: an organization that disappears removes the access.
  it('removes the membership of an organization absent from the claims', async () => {
    const { auth } = setup()
    await auth.authenticate(bearer(await token({ orgs: ['lab', 'ops'] })))
    expect((await auth.authenticate(bearer(await token({ orgs: ['lab'] }))))?.orgs).toEqual([
      { id: 'lab', roles: [] },
    ])
  })

  it('refuses an expired token, one from another issuer, or one for another audience', async () => {
    const { auth } = setup()
    const past = Math.floor(Date.now() / 1000) - 3600
    expect(await auth.authenticate(bearer(await token({}, { exp: past })))).toBeNull()
    expect(
      await auth.authenticate(bearer(await token({}, { iss: 'https://evil.test' }))),
    ).toBeNull()
    expect(await auth.authenticate(bearer(await token({}, { aud: 'other' })))).toBeNull()
  })

  it('refuses an unsigned token (alg none)', async () => {
    const { auth } = setup()
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${part({ alg: 'none' })}.${part({ iss: ISSUER, aud: AUDIENCE, sub: 'alice', exp: now + 300 })}.`
    expect(await auth.authenticate(bearer(unsigned))).toBeNull()
  })
})

describe('application session and keys', () => {
  const secret = 's'.repeat(32)
  const cookieRequest = (cookie: string) =>
    new Request('https://hub.test/', { headers: { cookie } })
  const cookieOf = (header: string) => header.split(';')[0] as string

  it('recognizes a signed session only until it expires', async () => {
    const repo = new MemoryRepo()
    const header = await sessionCookie(secret, 'u7', 0)
    const at = (now: number) => appAuth({ repo, sessionSecret: secret, now: () => now })
    expect((await at(1000).authenticate(cookieRequest(cookieOf(header))))?.id).toBe('u7')
    expect(await at(13 * 3600 * 1000).authenticate(cookieRequest(cookieOf(header)))).toBeNull()
  })

  it('refuses a modified session cookie', async () => {
    const repo = new MemoryRepo()
    const header = cookieOf(await sessionCookie(secret, 'u7'))
    // A middle character of the signature carries 6 bits; the last one may carry only padding.
    const at = header.lastIndexOf('.') + 10
    const forged = header.slice(0, at) + (header[at] === 'A' ? 'B' : 'A') + header.slice(at + 1)
    expect(
      await appAuth({ repo, sessionSecret: secret }).authenticate(cookieRequest(forged)),
    ).toBeNull()
  })

  it('signs in through the adapter when the session cookie names a removed account', async () => {
    const repo = new MemoryRepo()
    repo.principal = async (userId) =>
      userId === 'u7' ? null : { id: userId, kind: 'user', orgs: [], scopes: [] }
    const adapter = { authenticate: async () => repo.principal('u8') }
    const header = cookieOf(await sessionCookie(secret, 'u7'))
    const auth = appAuth({ repo, sessionSecret: secret, adapter })
    expect((await auth.authenticate(cookieRequest(header)))?.id).toBe('u8')
  })

  it('no longer recognizes a revoked API key', async () => {
    const repo = new MemoryRepo()
    const key = 'wica_test-key'
    repo.keys.set(await hashKey(key), { id: 'u3', kind: 'apiKey', orgs: [], scopes: [] })
    const auth = appAuth({ repo, sessionSecret: secret })
    expect((await auth.authenticate(bearer(key)))?.id).toBe('u3')
    repo.keys.clear()
    expect(await auth.authenticate(bearer(key))).toBeNull()
  })
})
