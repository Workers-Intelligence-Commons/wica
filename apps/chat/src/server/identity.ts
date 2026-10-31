// Identity: the rest of the application sees only a `Principal`. API keys and the session cookie
// belong to the application; a configured adapter (bootstrap, generic OIDC or trusted proxy)
// also recognizes external identities.
//
// Adapter contract:
// - An external identity is linked to an internal account by (provider, subject); every
//   reference points to the internal account.
// - Organization memberships follow the claims at each login: an organization absent from the
//   claims removes the membership.
// - Logout: the cookie is cleared and the page reloaded; a stolen cookie stays valid until it
//   expires, which is soon. A deleted account is no longer recognized.
// - Revocation: a revoked API key is no longer recognized from the next request on.
// - Refresh: the application session does not depend on the provider token; when it expires,
//   the person logs in again.

import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose'

import { sha256Hex, sign, verify } from './crypto.ts'

export type Principal = {
  /** Stable internal identifier: the account, or the organization of an organization key. */
  id: string
  kind: 'user' | 'apiKey'
  orgs: { id: string; roles: string[] }[]
  scopes: string[]
}

export interface AuthProvider {
  authenticate(req: Request): Promise<Principal | null>
}

/** Profile of an external identity, as the adapter read it from its claims. */
export type ExternalProfile = {
  provider: string
  subject: string
  name: string
  /** Organizations and roles according to the claims; `undefined` leaves the memberships as they are. */
  orgs?: { name: string; roles: string[] }[]
}

export interface IdentityRepo {
  principal(userId: string): Promise<Principal | null>
  apiKey(hash: string): Promise<Principal | null>
  /** Internal account of the identity, created at the first login, memberships up to date. */
  link(profile: ExternalProfile): Promise<string>
}

export const SESSION_COOKIE = 'wica_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return undefined
}

const bearer = (req: Request) => {
  const header = req.headers.get('authorization') ?? ''
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
}

/** Signed session cookie, linked to the internal account. */
export async function sessionCookie(secret: string, userId: string, now = Date.now()) {
  const value = await sign(secret, { uid: userId, exp: now + SESSION_TTL_MS })
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

/** Account of the browser session, if its cookie is signed and not expired. */
export async function sessionUser(secret: string, req: Request, now = Date.now()) {
  const value = readCookie(req, SESSION_COOKIE)
  if (!value) return null
  const session = await verify<{ uid: string; exp: number }>(secret, value)
  return session && session.exp > now ? session.uid : null
}

/** Application API key, hashed in the database; prefix `wica_`. */
export const API_KEY_PREFIX = 'wica'
export const hashKey = (token: string) => sha256Hex(token)

export type AppAuthOptions = {
  repo: IdentityRepo
  sessionSecret: string
  /** Configured adapter, tried after the cookie and the API keys. */
  adapter?: AuthProvider
  now?: () => number
}

/** Session cookie, then API key, then the configured adapter. */
export function appAuth(options: AppAuthOptions): AuthProvider {
  return {
    async authenticate(req) {
      const userId = await sessionUser(options.sessionSecret, req, options.now?.())
      if (userId) return options.repo.principal(userId)
      const token = bearer(req)
      if (token?.startsWith(`${API_KEY_PREFIX}_`)) return options.repo.apiKey(await hashKey(token))
      return options.adapter ? options.adapter.authenticate(req) : null
    },
  }
}

/**
 * Bootstrap: an initial admin token, compared in constant time, to create the first accounts and
 * their keys. No password and no session of its own.
 */
export function bootstrapAuth(adminToken: string): AuthProvider {
  return {
    async authenticate(req) {
      const token = bearer(req)
      if (!token || !(await sameSecret(token, adminToken))) return null
      return { id: 'admin', kind: 'apiKey', orgs: [], scopes: ['admin'] }
    },
  }
}

async function sameSecret(a: string, b: string) {
  // Comparing hashes equalizes the lengths; the byte comparison is in constant time.
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

export type OidcOptions = {
  issuer: string
  /** Expected audience: the identifier of the application client. */
  audience: string
  /** Accepted signature algorithms; `none` is never one of them. */
  algorithms?: string[]
  /** Tolerated clock skew, in seconds. */
  clockToleranceSec?: number
  /** Organizations claim: list of names, or of `{ name, roles }` objects. */
  orgsClaim?: string
  /** Roles claim, applied to each organization when the organizations claim is a list of names. */
  rolesClaim?: string
  /** Public keys; by default the ones the issuer publishes (discovery). */
  keys?: JWTVerifyGetKey
  fetch?: typeof fetch
}

export type OidcDiscovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

export async function discover(issuer: string, f: typeof fetch = fetch): Promise<OidcDiscovery> {
  const response = await f(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status}).`)
  return (await response.json()) as OidcDiscovery
}

const DEFAULT_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'EdDSA']

/** Organizations according to the claims, or `undefined` if the issuer does not provide any. */
export function orgsFromClaims(
  claims: JWTPayload,
  orgsClaim: string | undefined,
  rolesClaim: string | undefined,
): ExternalProfile['orgs'] {
  if (!orgsClaim) return undefined
  const raw = claims[orgsClaim]
  if (raw === undefined) return []
  const roles =
    rolesClaim && Array.isArray(claims[rolesClaim]) ? (claims[rolesClaim] as string[]) : []
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') return [{ name: entry, roles }]
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { name?: unknown }).name === 'string'
    ) {
      const e = entry as { name: string; roles?: unknown }
      return [{ name: e.name, roles: Array.isArray(e.roles) ? e.roles.map(String) : [] }]
    }
    return []
  })
}

/**
 * Verifies an issuer token: signature by its public keys, issuer, audience, allowed algorithm and
 * expiry, with the tolerated clock skew.
 */
export function oidcVerifier(options: OidcOptions) {
  let keys = options.keys
  const getKeys = async () => {
    if (!keys) {
      const discovery = await discover(options.issuer, options.fetch)
      keys = createRemoteJWKSet(new URL(discovery.jwks_uri))
    }
    return keys
  }
  const algorithms = (options.algorithms ?? DEFAULT_ALGORITHMS).filter(
    (a) => a.toLowerCase() !== 'none',
  )
  return async (token: string): Promise<ExternalProfile> => {
    const { payload } = await jwtVerify(token, await getKeys(), {
      issuer: options.issuer,
      audience: options.audience,
      algorithms,
      clockTolerance: options.clockToleranceSec ?? 60,
      requiredClaims: ['sub', 'exp'],
    })
    const name =
      (typeof payload.name === 'string' && payload.name) ||
      (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
      (payload.sub as string)
    const orgs = orgsFromClaims(payload, options.orgsClaim, options.rolesClaim)
    return {
      provider: options.issuer,
      subject: payload.sub as string,
      name,
      ...(orgs ? { orgs } : {}),
    }
  }
}

/** Generic OIDC: an access token from the issuer, in `Authorization: Bearer`. */
export function oidcAuth(repo: IdentityRepo, options: OidcOptions): AuthProvider {
  const verifyToken = oidcVerifier(options)
  return {
    async authenticate(req) {
      const token = bearer(req)
      if (!token) return null
      try {
        return await repo.principal(await repo.link(await verifyToken(token)))
      } catch {
        return null
      }
    },
  }
}

export type TrustedProxyOptions = {
  /** Header that carries the subject authenticated by the proxy, for example `Remote-User`. */
  userHeader: string
  nameHeader?: string
  /** Groups header, separated by commas, read as organizations. */
  groupsHeader?: string
  /** Proxy addresses; a request from elsewhere is never read by its headers. */
  proxies: string[]
  /** Address of the incoming connection, provided by the host. */
  clientAddress: (req: Request) => string | undefined
  provider?: string
}

/**
 * Trusted proxy: the identity header is read only on a connection that comes from the proxy. A
 * request from another address that carries it is ignored, so that no one can use it to pass as
 * someone else.
 */
export function trustedProxyAuth(repo: IdentityRepo, options: TrustedProxyOptions): AuthProvider {
  return {
    async authenticate(req) {
      const address = options.clientAddress(req)
      if (!address || !options.proxies.includes(address)) return null
      const subject = req.headers.get(options.userHeader)?.trim()
      if (!subject) return null
      const groups = options.groupsHeader ? req.headers.get(options.groupsHeader) : null
      const userId = await repo.link({
        provider: options.provider ?? 'proxy',
        subject,
        name: (options.nameHeader && req.headers.get(options.nameHeader)?.trim()) || subject,
        ...(options.groupsHeader
          ? {
              orgs: (groups ?? '')
                .split(',')
                .map((g) => g.trim())
                .filter(Boolean)
                .map((name) => ({ name, roles: [] })),
            }
          : {}),
      })
      return repo.principal(userId)
    },
  }
}

/** OIDC authorization request with PKCE: the address to send the browser to, and what to keep. */
export async function authorizationRequest(
  discovery: OidcDiscovery,
  client: { clientId: string; redirectUri: string; scope?: string },
) {
  const verifier = randomUrlSafe(32)
  const state = randomUrlSafe(16)
  const challenge = await pkceChallenge(verifier)
  const url = new URL(discovery.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: client.scope ?? 'openid profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return { url: url.toString(), verifier, state }
}

/** Exchanges the code for an identity token, then verifies it like any issuer token. */
export async function exchangeCode(
  discovery: OidcDiscovery,
  client: { clientId: string; clientSecret?: string; redirectUri: string },
  code: string,
  verifier: string,
  f: typeof fetch = fetch,
): Promise<string> {
  const response = await f(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }),
  })
  if (!response.ok) throw new Error(`The code exchange was refused (${response.status}).`)
  const body = (await response.json()) as { id_token?: string }
  if (!body.id_token) throw new Error('The issuer answered without an identity token.')
  return body.id_token
}

function randomUrlSafe(bytes: number) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export async function pkceChallenge(verifier: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  )
  return btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
