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
  trustedProxyAuth,
} from '../src/server/identity.ts'

/** Dépôt d'identités en mémoire : comptes reliés par (fournisseur, sujet), appartenances suivies. */
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
const AUDIENCE = 'wica-chat'
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
  new Request('https://chat.test/', { headers: { authorization: `Bearer ${value}` } })

describe('adaptateur OIDC', () => {
  const setup = () => {
    const repo = new MemoryRepo()
    return {
      repo,
      auth: oidcAuth(repo, { issuer: ISSUER, audience: AUDIENCE, keys, orgsClaim: 'orgs' }),
    }
  }

  it('relie un jeton valide au même compte interne à chaque connexion', async () => {
    const { auth } = setup()
    const first = await auth.authenticate(bearer(await token({ orgs: ['lab'] })))
    const second = await auth.authenticate(bearer(await token({ orgs: ['lab'] })))
    expect(first).toMatchObject({ id: 'u1', kind: 'user', orgs: [{ id: 'lab' }] })
    expect(second?.id).toBe('u1')
  })

  // Les appartenances suivent les claims : une organisation qui disparaît retire l'accès.
  it('retire l’appartenance d’une organisation absente des claims', async () => {
    const { auth } = setup()
    await auth.authenticate(bearer(await token({ orgs: ['lab', 'ops'] })))
    expect((await auth.authenticate(bearer(await token({ orgs: ['lab'] }))))?.orgs).toEqual([
      { id: 'lab', roles: [] },
    ])
  })

  it('refuse un jeton échu, d’un autre émetteur ou pour une autre audience', async () => {
    const { auth } = setup()
    const past = Math.floor(Date.now() / 1000) - 3600
    expect(await auth.authenticate(bearer(await token({}, { exp: past })))).toBeNull()
    expect(
      await auth.authenticate(bearer(await token({}, { iss: 'https://evil.test' }))),
    ).toBeNull()
    expect(await auth.authenticate(bearer(await token({}, { aud: 'autre' })))).toBeNull()
  })

  it('refuse un jeton non signé (alg none)', async () => {
    const { auth } = setup()
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${part({ alg: 'none' })}.${part({ iss: ISSUER, aud: AUDIENCE, sub: 'alice', exp: now + 300 })}.`
    expect(await auth.authenticate(bearer(unsigned))).toBeNull()
  })
})

describe('proxy de confiance', () => {
  const make = () => {
    const repo = new MemoryRepo()
    const auth = trustedProxyAuth(repo, {
      userHeader: 'remote-user',
      groupsHeader: 'remote-groups',
      proxies: ['10.0.0.2'],
      clientAddress: (req) => req.headers.get('x-test-address') ?? undefined,
    })
    return auth
  }
  const request = (address: string) =>
    new Request('https://chat.test/', {
      headers: { 'remote-user': 'alice', 'remote-groups': 'lab', 'x-test-address': address },
    })

  it('lit l’identité sur une connexion du proxy', async () => {
    expect(await make().authenticate(request('10.0.0.2'))).toMatchObject({
      id: 'u1',
      orgs: [{ id: 'lab' }],
    })
  })

  // Sinon n'importe qui pourrait se faire passer pour une autre personne en posant l'en-tête.
  it('ignore l’en-tête d’identité venu d’une autre adresse', async () => {
    expect(await make().authenticate(request('203.0.113.9'))).toBeNull()
  })
})

describe('session et clés de l’application', () => {
  const secret = 's'.repeat(32)
  const cookieRequest = (cookie: string) =>
    new Request('https://chat.test/', { headers: { cookie } })
  const cookieOf = (header: string) => header.split(';')[0] as string

  it('reconnaît une session signée jusqu’à son échéance seulement', async () => {
    const repo = new MemoryRepo()
    const header = await sessionCookie(secret, 'u7', 0)
    const at = (now: number) => appAuth({ repo, sessionSecret: secret, now: () => now })
    expect((await at(1000).authenticate(cookieRequest(cookieOf(header))))?.id).toBe('u7')
    expect(await at(13 * 3600 * 1000).authenticate(cookieRequest(cookieOf(header)))).toBeNull()
  })

  it('refuse un cookie de session modifié', async () => {
    const repo = new MemoryRepo()
    const header = cookieOf(await sessionCookie(secret, 'u7'))
    // Un caractère du milieu de la signature porte 6 bits ; le dernier peut ne porter que du remplissage.
    const at = header.lastIndexOf('.') + 10
    const forged = header.slice(0, at) + (header[at] === 'A' ? 'B' : 'A') + header.slice(at + 1)
    expect(
      await appAuth({ repo, sessionSecret: secret }).authenticate(cookieRequest(forged)),
    ).toBeNull()
  })

  it('ne reconnaît plus une clé d’API révoquée', async () => {
    const repo = new MemoryRepo()
    const key = 'wica_cle-de-test'
    repo.keys.set(await hashKey(key), { id: 'u3', kind: 'apiKey', orgs: [], scopes: [] })
    const auth = appAuth({ repo, sessionSecret: secret })
    expect((await auth.authenticate(bearer(key)))?.id).toBe('u3')
    repo.keys.clear()
    expect(await auth.authenticate(bearer(key))).toBeNull()
  })
})
