// Identité : le reste de l'application ne voit qu'un `Principal`. Les clés d'API et le cookie
// de session appartiennent à l'application ; un adaptateur configuré (amorçage, OIDC générique
// ou proxy de confiance) reconnaît en plus les identités externes.
//
// Contrat des adaptateurs :
// - Une identité externe est reliée à un compte interne par (fournisseur, sujet) ; toute
//   référence pointe sur le compte interne.
// - Les appartenances aux organisations suivent les claims à chaque connexion : une
//   organisation absente des claims retire l'appartenance.
// - Déconnexion : le cookie est effacé et la page rechargée ; un cookie volé reste valable
//   jusqu'à son échéance, qui est courte. Un compte supprimé n'est plus reconnu.
// - Révocation : une clé d'API révoquée n'est plus reconnue dès la requête suivante.
// - Rafraîchissement : la session de l'application ne dépend pas du jeton du fournisseur ; à
//   son échéance, la personne se reconnecte.

import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose'

import { sha256Hex, sign, verify } from './crypto.ts'

export type Principal = {
  /** Identifiant interne stable : le compte, ou l'organisation d'une clé d'organisation. */
  id: string
  kind: 'user' | 'apiKey'
  orgs: { id: string; roles: string[] }[]
  scopes: string[]
}

export interface AuthProvider {
  authenticate(req: Request): Promise<Principal | null>
}

/** Profil d'une identité externe, tel que l'adaptateur l'a lu dans ses claims. */
export type ExternalProfile = {
  provider: string
  subject: string
  name: string
  /** Organisations et rôles d'après les claims ; `undefined` laisse les appartenances telles quelles. */
  orgs?: { name: string; roles: string[] }[]
}

export interface IdentityRepo {
  principal(userId: string): Promise<Principal | null>
  apiKey(hash: string): Promise<Principal | null>
  /** Compte interne de l'identité, créé à la première connexion, appartenances à jour. */
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

/** Cookie de session signé, lié au compte interne. */
export async function sessionCookie(secret: string, userId: string, now = Date.now()) {
  const value = await sign(secret, { uid: userId, exp: now + SESSION_TTL_MS })
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

/** Compte de la session du navigateur, si son cookie est signé et pas échu. */
export async function sessionUser(secret: string, req: Request, now = Date.now()) {
  const value = readCookie(req, SESSION_COOKIE)
  if (!value) return null
  const session = await verify<{ uid: string; exp: number }>(secret, value)
  return session && session.exp > now ? session.uid : null
}

/** Clé d'API de l'application, hachée en base ; préfixe `wica_`. */
export const API_KEY_PREFIX = 'wica'
export const hashKey = (token: string) => sha256Hex(token)

export type AppAuthOptions = {
  repo: IdentityRepo
  sessionSecret: string
  /** Adaptateur configuré, essayé après le cookie et les clés d'API. */
  adapter?: AuthProvider
  now?: () => number
}

/** Cookie de session, puis clé d'API, puis l'adaptateur configuré. */
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
 * Amorçage : un jeton d'admin initial, comparé en temps constant, pour créer les premiers
 * comptes et leurs clés. Ni mot de passe ni session propre.
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
  // Comparer les empreintes égalise les longueurs ; la comparaison des octets est en temps constant.
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

export type OidcOptions = {
  issuer: string
  /** Audience attendue : l'identifiant du client de l'application. */
  audience: string
  /** Algorithmes de signature acceptés ; `none` n'en fait jamais partie. */
  algorithms?: string[]
  /** Décalage d'horloge toléré, en secondes. */
  clockToleranceSec?: number
  /** Claim des organisations : liste de noms, ou d'objets `{ name, roles }`. */
  orgsClaim?: string
  /** Claim des rôles, appliqués à chaque organisation quand le claim des organisations est une liste de noms. */
  rolesClaim?: string
  /** Clés publiques ; par défaut celles que publie l'émetteur (découverte). */
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

/** Organisations d'après les claims, ou `undefined` si l'émetteur n'en fournit pas. */
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
 * Vérifie un jeton de l'émetteur : signature par ses clés publiques, émetteur, audience,
 * algorithme autorisé et échéance, avec le décalage d'horloge toléré.
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

/** OIDC générique : un jeton d'accès de l'émetteur, en `Authorization: Bearer`. */
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
  /** En-tête qui porte le sujet authentifié par le proxy, par exemple `Remote-User`. */
  userHeader: string
  nameHeader?: string
  /** En-tête des groupes, séparés par des virgules, lus comme des organisations. */
  groupsHeader?: string
  /** Adresses du proxy ; une requête d'ailleurs n'est jamais lue par ses en-têtes. */
  proxies: string[]
  /** Adresse de la connexion entrante, fournie par l'hôte. */
  clientAddress: (req: Request) => string | undefined
  provider?: string
}

/**
 * Proxy de confiance : l'en-tête d'identité n'est lu que sur une connexion qui vient du
 * proxy. Une requête d'une autre adresse qui le porte est ignorée, pour qu'on ne puisse pas
 * s'en servir pour se faire passer pour quelqu'un d'autre.
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

/** Requête d'autorisation OIDC avec PKCE : l'adresse où envoyer le navigateur, et ce qu'il faut garder. */
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

/** Échange le code contre un jeton d'identité, puis le vérifie comme tout jeton de l'émetteur. */
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
