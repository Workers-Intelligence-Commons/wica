// Tool servers (MCP) of the accounts: their secrets, encrypted by the instance key; the OAuth
// sign-in of the MCP standard, with automatic client registration; the tokens that the turns
// send, refreshed under the lease of the connection; and the connections of one turn. The servers
// that people add are reached through the platform's `fetch` restricted to public addresses; the
// catalog servers, which an admin added, through the plain `fetch`.

import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import { connectMcp, type McpConnections, type McpServerConfig } from '@wica/mcp'
import type { Credential, CredentialStore } from '@wica/runtime'

import { decrypt, encrypt, type InstanceKey } from './crypto.ts'
import type { McpConnection, McpServers, SealedSecret } from './data.ts'
import { underLease } from './lease.ts'

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const MCP_CALLBACK_PATH = '/auth/mcp/callback'

/** Name of a tool server: it prefixes its tools (`<name>__<tool>`). */
export const MCP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

export type TokenSecret = { kind: 'token'; token: string }

/** State of an OAuth sign-in, as the MCP SDK reads and writes it. */
export type OAuthSecret = {
  kind: 'oauth'
  /** Callback address registered with the authorization server. */
  redirectUrl: string
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  /** End of the access token, in milliseconds. */
  expiresAt?: number
  verifier?: string
  discovery?: OAuthDiscoveryState
}

export type McpSecret = TokenSecret | OAuthSecret

/** Refreshes an OAuth sign-in; `null` when the server asks for a new sign-in. */
export type Refresher = (
  connection: McpConnection,
  secret: OAuthSecret,
) => Promise<OAuthSecret | null>

/** A token this close to its end is refreshed before use. */
const EXPIRY_MARGIN_MS = 60_000

/** The SDK's view of an OAuth secret: each `save` call changes `secret` in place. */
function oauthProvider(
  secret: OAuthSecret,
  now: () => number,
  interactive: { state: string; onRedirect: (url: URL) => void } | null,
): OAuthClientProvider {
  return {
    get redirectUrl() {
      return secret.redirectUrl
    },
    get clientMetadata() {
      return {
        client_name: 'Wica hub',
        redirect_uris: [secret.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },
    ...(interactive ? { state: () => interactive.state } : {}),
    clientInformation: () => secret.client,
    saveClientInformation: (client) => {
      secret.client = client
    },
    tokens: () => secret.tokens,
    saveTokens: (tokens) => {
      secret.tokens = tokens
      if (tokens.expires_in) secret.expiresAt = now() + tokens.expires_in * 1000
      else delete secret.expiresAt
    },
    // Outside a sign-in, a request for a new authorization only marks the connection.
    redirectToAuthorization: (url) => interactive?.onRedirect(url),
    saveCodeVerifier: (verifier) => {
      secret.verifier = verifier
    },
    codeVerifier: () => {
      if (!secret.verifier) throw new Error('No sign-in is in progress for this tool server.')
      return secret.verifier
    },
    saveDiscoveryState: (discovery) => {
      secret.discovery = discovery
    },
    discoveryState: () => secret.discovery,
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'client') delete secret.client
      if (scope === 'all' || scope === 'tokens') {
        delete secret.tokens
        delete secret.expiresAt
      }
      if (scope === 'all' || scope === 'verifier') delete secret.verifier
      if (scope === 'all' || scope === 'discovery') delete secret.discovery
    },
  }
}

const credentialOf = (secret: McpSecret | null): Credential | undefined => {
  if (!secret) return undefined
  if (secret.kind === 'token') return { token: secret.token }
  const token = secret.tokens?.access_token
  if (!token) return undefined
  return secret.expiresAt !== undefined ? { token, expiresAt: secret.expiresAt } : { token }
}

export function mcpAccess(options: {
  servers: McpServers
  key: Promise<InstanceKey>
  /** `fetch` restricted to public addresses, for the servers that people add. */
  publicFetch: Fetch
  refresh?: Refresher
  now?: () => number
}) {
  const { servers } = options
  const now = options.now ?? Date.now
  const fetchFor = (connection: Pick<McpConnection, 'catalogId'>): Fetch =>
    connection.catalogId ? fetch : options.publicFetch

  const seal = async (secret: McpSecret | null): Promise<SealedSecret | null> =>
    secret ? encrypt(await options.key, JSON.stringify(secret)) : null
  const open = async (sealed: SealedSecret | null): Promise<McpSecret | null> =>
    sealed ? (JSON.parse(await decrypt(await options.key, sealed)) as McpSecret) : null

  const refresher: Refresher =
    options.refresh ??
    (async (connection, secret) => {
      const next = structuredClone(secret)
      const result = await auth(oauthProvider(next, now, null), {
        serverUrl: connection.url,
        fetchFn: fetchFor(connection),
      })
      return result === 'AUTHORIZED' ? next : null
    })

  const expiring = (credential: Credential) =>
    credential.expiresAt !== undefined && credential.expiresAt - EXPIRY_MARGIN_MS <= now()

  /** Refresh under the lease of the connection (`lease.ts`). */
  async function refresh(id: string, stale?: string): Promise<Credential | undefined> {
    const connection = await servers.connection(id)
    if (!connection || connection.status !== 'connected') return undefined
    const result = await underLease(
      (until, start) => servers.lease(id, until, start),
      async (held, until) => {
        let next: OAuthSecret | null
        try {
          const secret = await open(held.secret)
          const current = credentialOf(secret)
          const replaced =
            current && (stale !== undefined ? current.token !== stale : !expiring(current))
          if (replaced || secret?.kind !== 'oauth') {
            await servers.release(id, until)
            return current
          }
          next = await refresher(connection, secret)
        } catch (error) {
          await servers.release(id, until)
          throw error
        }
        if (!next) {
          await servers.release(id, until, { status: 'sign_in' })
          return undefined
        }
        await servers.release(id, until, { secret: await seal(next), status: 'connected' })
        return credentialOf(next)
      },
      now,
    )
    return result === 'missing' ? undefined : result
  }

  /** Tokens of the connections, keyed by connection identifier. */
  const credentials: CredentialStore = {
    async get(id) {
      const connection = await servers.connection(id)
      if (!connection || connection.status !== 'connected') return undefined
      const current = credentialOf(await open(connection.secret))
      return current && expiring(current) ? refresh(id) : current
    },
    refresh,
    async revoke(id) {
      const connection = await servers.connection(id)
      if (connection) await servers.save(id, { secret: connection.secret, status: 'sign_in' })
    },
  }

  /**
   * Starts the OAuth sign-in of a connection: registers the hub with the authorization server
   * when needed, and returns the address where the person signs in; `null` when the server
   * granted access without one.
   */
  async function startSignIn(
    connection: McpConnection,
    redirectUrl: string,
    state: string,
  ): Promise<URL | null> {
    const secret: OAuthSecret = { kind: 'oauth', redirectUrl }
    let target: URL | null = null
    const result = await auth(
      oauthProvider(secret, now, { state, onRedirect: (url) => (target = url) }),
      { serverUrl: connection.url, fetchFn: fetchFor(connection) },
    )
    await servers.save(connection.id, {
      secret: await seal(secret),
      status: result === 'AUTHORIZED' ? 'connected' : 'sign_in',
    })
    return result === 'AUTHORIZED' ? null : target
  }

  /** Exchanges the code that the authorization server sent back for the tokens. */
  async function finishSignIn(
    connection: McpConnection & { secret: SealedSecret | null },
    code: string,
    iss: string | null,
  ) {
    const secret = await open(connection.secret)
    if (secret?.kind !== 'oauth') throw new Error('This tool server has no OAuth sign-in.')
    await auth(oauthProvider(secret, now, null), {
      serverUrl: connection.url,
      authorizationCode: code,
      ...(iss ? { iss } : {}),
      fetchFn: fetchFor(connection),
    })
    delete secret.verifier
    await servers.save(connection.id, { secret: await seal(secret), status: 'connected' })
  }

  /** Connections of one turn to the account's tool servers; the caller closes them. */
  async function connect(userId: string): Promise<McpConnections> {
    const usable = (await servers.connections(userId)).filter((c) => c.status === 'connected')
    const config = (c: McpConnection): McpServerConfig => ({
      name: c.name,
      url: c.url,
      ...(c.auth !== 'none' ? { credential: { store: credentials, key: c.id } } : {}),
    })
    const groups = await Promise.all([
      connectMcp(usable.filter((c) => c.catalogId).map(config)),
      connectMcp(usable.filter((c) => !c.catalogId).map(config), { fetch: options.publicFetch }),
    ])
    return {
      tools: () => groups.flatMap((g) => g.tools()),
      close: async () => {
        await Promise.all(groups.map((g) => g.close()))
      },
    }
  }

  return { seal, credentials, startSignIn, finishSignIn, connect }
}

export type McpAccess = ReturnType<typeof mcpAccess>
