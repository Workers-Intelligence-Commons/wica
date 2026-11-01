// Hub server: the HTTP routes of the application around the Harness. The routes check the
// session and the ownership, then hand each request to a data contract (see `data.ts`); a
// command becomes a short turn in the request, and the rest of the turn leaves as a wake-up.

import type { Envelope } from '@wica/protocol'

import { addressProblem } from './addresses.ts'
import type { HubConfig } from './config.ts'
import { sign, verify } from './crypto.ts'
import {
  type Accounts,
  ADMIN_ROLE,
  type ConversationHost,
  type ConversationIndex,
  type McpAuth,
  type McpConnection,
  type McpServers,
  type SignInPrompts,
  type Skills,
  type SkillVisibility,
} from './data.ts'
import {
  adminTokenAuth,
  appAuth,
  authorizationRequest,
  type AuthProvider,
  clearSessionCookie,
  discover,
  exchangeCode,
  oidcAuth,
  oidcVerifier,
  type Principal,
  readCookie,
  sessionCookie,
  trustedProxyAuth,
} from './identity.ts'
import {
  INSTANCE_LEVELS,
  listProviders,
  loginFlow,
  type ModelOption,
  parseModelChoice,
  piLevels,
  testModelOptions,
  userModels,
} from './models.ts'
import type { EmailSender } from './email.ts'
import { MCP_CALLBACK_PATH, MCP_NAME, type McpAccess } from './mcp.ts'
import { mayPublish, mayRemove, skillProblem } from './skills.ts'
import type { ModelTokens } from './tokens.ts'
import { PASSWORD_LENGTH } from '../shared/accounts.ts'
import type { Me, SignIn } from '../shared/session.ts'
import {
  ACCOUNT_PATH,
  type AuthDatabase,
  BETTER_AUTH_PROVIDER,
  betterAuthConnector,
} from './better-auth.ts'

/** Tables that the pages sync. */
export type SyncTable = 'conversations' | 'items' | 'item_chunks' | 'model_calls'

/**
 * Rows that a request may read: those of `owner`, and of `conversationId` once the hub has checked
 * that the account owns it.
 */
export type SyncScope = { owner: string; conversationId?: string }

export type Platform = {
  /** Address of the incoming connection, for the trusted proxy. */
  clientAddress: (req: Request) => string | undefined
  /** Opens the live socket of a conversation, on a platform that syncs through one. */
  live?: (req: Request, conversationId: string) => Promise<Response>
  /** Streams the rows of a table in `scope`, on a platform whose pages sync them over HTTP. */
  rows?: (req: Request, table: SyncTable, scope: SyncScope) => Promise<Response>
  /** Sender of the emails of the hub's accounts; absent, no email leaves. */
  email?: EmailSender
}

/** What the hub server works on: the storage contracts, and the services built over them. */
export type HubData = {
  accounts: Accounts
  index: ConversationIndex
  host: ConversationHost
  tokens: ModelTokens
  prompts: SignInPrompts
  /** Storage of the Better Auth accounts. */
  authDatabase: AuthDatabase
  mcp: McpServers
  /** Sign-ins and tokens of the tool servers, over `mcp`. */
  mcpAccess: McpAccess
  skills: Skills
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const error = (status: number, message: string) => json({ error: message }, status)

const OIDC_COOKIE = 'wica_oidc'
const SIGN_IN_MS = 10 * 60_000

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

const httpUrl = (text: unknown) => {
  if (typeof text !== 'string') return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

const MCP_AUTHS: McpAuth[] = ['none', 'token', 'oauth']
const VISIBILITIES: SkillVisibility[] = ['private', 'organization', 'instance']
/** Scope of the keys that an account creates: everything the account does, without the admin role. */
const API_KEY_SCOPE = 'chat'

export function hubServer(config: HubConfig, data: HubData, platform: Platform) {
  const { accounts: repo, index, host, tokens, prompts } = data
  const mcp = data.mcpAccess

  const accounts =
    config.auth.kind === 'accounts'
      ? betterAuthConnector(repo, {
          database: data.authDatabase,
          sessionSecret: config.sessionSecret,
          ...(platform.email ? { email: platform.email } : {}),
        })
      : undefined
  let adapter: AuthProvider | undefined = accounts?.provider
  if (config.auth.kind === 'oidc') {
    adapter = oidcAuth(repo, { issuer: config.auth.issuer, audience: config.auth.clientId })
  }
  if (config.auth.kind === 'proxy') {
    adapter = trustedProxyAuth(repo, { ...config.auth, clientAddress: platform.clientAddress })
  }
  const signIn: SignIn = { kind: config.auth.kind, email: Boolean(accounts && platform.email) }
  const auth = appAuth({
    repo,
    sessionSecret: config.sessionSecret,
    ...(adapter ? { adapter } : {}),
  })
  // The admin token is valid in every mode.
  const admin = config.adminToken ? adminTokenAuth(config.adminToken) : undefined

  async function principalOf(req: Request): Promise<Principal | null> {
    return (await auth.authenticate(req)) ?? (admin ? admin.authenticate(req) : null)
  }

  async function ownConversation(principal: Principal, conversationId: string | null) {
    if (!conversationId) return null
    const entry = await index.get(conversationId)
    return entry && entry.ownerId === principal.id ? entry : null
  }

  async function command(req: Request, principal: Principal) {
    const envelope = (await req.json()) as Envelope
    if (envelope?.kind !== 'command' || typeof envelope.commandId !== 'string') {
      return error(400, 'a command was expected')
    }
    const conversation = await ownConversation(principal, envelope.conversationId)
    if (!conversation) return error(404, 'conversation not found')
    const harnessSession = req.headers.get('x-wica-session') ?? undefined
    const outcome = await host.command(envelope, {
      userId: principal.id,
      ...(harnessSession ? { harnessSession } : {}),
    })
    if (outcome.kind === 'conflict') return error(409, 'this id is already taken')
    if (envelope.command.t === 'send') {
      await autoTitle(conversation.id, envelope.command.parts)
      // A message accepted while its owner contributes gives the conversation, for good.
      if (outcome.ack.ok && (await repo.contributor(principal.id))) {
        await index.markContributed(conversation.id)
      }
    }
    const { ack, sessionId } = outcome
    return json(ack, ack.ok ? 200 : 422, sessionId ? { 'x-wica-session': sessionId } : {})
  }

  async function autoTitle(conversationId: string, parts: { type: string; text?: string }[]) {
    const text = parts
      .flatMap((p) => (p.type === 'text' && p.text ? [p.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return
    await index.setTitleIfEmpty(conversationId, text.length > 60 ? `${text.slice(0, 59)}…` : text)
  }

  async function createConversation(req: Request, principal: Principal) {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string
      model?: string | null
    }
    if (!knownModel(body.model)) return error(400, 'unknown model')
    const created = await index.create({
      ownerId: principal.id,
      title: body.title ?? '',
      model: body.model ?? null,
    })
    return json(created, 201)
  }

  /** A model a conversation may use: absent or `null` is the default model. */
  function knownModel(model: string | null | undefined) {
    if (!model) return true
    const choice = parseModelChoice(model)
    return choice !== null && !(choice.kind === 'lorem' && !config.testModels)
  }

  /** Changes the model of the next turns; the responses already written keep theirs. */
  async function updateConversation(req: Request, principal: Principal, conversationId: string) {
    const row = await ownConversation(principal, conversationId)
    if (!row) return error(404, 'conversation not found')
    const body = (await req.json().catch(() => ({}))) as { model?: string | null }
    if (!('model' in body) || !knownModel(body.model)) return error(400, 'unknown model')
    await index.setModel(conversationId, body.model ?? null)
    return new Response(null, { status: 204 })
  }

  async function deleteConversation(principal: Principal, conversationId: string) {
    const row = await ownConversation(principal, conversationId)
    if (!row) return error(404, 'conversation not found')
    // The journal goes first: if the index entry survives a failure, deleting again finishes.
    await host.erase(conversationId)
    await index.delete(conversationId)
    return new Response(null, { status: 204 })
  }

  async function credentialsRoute(req: Request, principal: Principal, rest: string[]) {
    const { credentials, models } = userModels(tokens, principal.id)
    if (rest.length === 0 && req.method === 'GET') {
      return json({ providers: await listProviders(models, credentials) })
    }
    if (rest[0] === 'api-key' && req.method === 'POST') {
      const body = (await req.json()) as { provider?: string; key?: string }
      if (!body.provider || !body.key || !models.getProvider(body.provider)?.auth.apiKey) {
        return error(400, 'a provider and a key were expected')
      }
      const apiKey = body.key
      await credentials.modify(body.provider, async () => ({ type: 'api_key', key: apiKey }))
      return json({ ok: true })
    }
    if (rest[0] === 'login' && rest[1] && rest[2] === 'answer' && req.method === 'POST') {
      const body = (await req.json()) as { answer?: string }
      const ok = await prompts.reply(principal.id, rest[1], body.answer ?? '')
      return ok ? json({ ok: true }) : error(404, 'sign-in not found')
    }
    if (rest[0] === 'login' && rest[1] && req.method === 'POST') {
      const provider = rest[1]
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const event of loginFlow(
            prompts,
            tokens,
            principal.id,
            provider,
            req.signal,
          )) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          }
          controller.close()
        },
      })
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      })
    }
    if (rest[0] && req.method === 'DELETE') {
      await credentials.delete(rest[0])
      return new Response(null, { status: 204 })
    }
    return error(404, 'unknown route')
  }

  async function modelsRoute(principal: Principal) {
    const { models } = userModels(tokens, principal.id)
    const available = await models.getAvailable().catch(() => [])
    const providerNames = new Map(models.getProviders().map((p) => [p.id, p.name]))
    return json({
      default: config.model
        ? ({
            id: null,
            name: config.model.id,
            group: 'This instance',
            provider: 'wic',
            levels: INSTANCE_LEVELS,
          } satisfies ModelOption)
        : null,
      models: [
        ...(config.testModels ? testModelOptions() : []),
        ...available.map((m): ModelOption => ({
          id: `pi:${m.provider}/${m.id}`,
          name: m.name,
          group: providerNames.get(m.provider) ?? m.provider,
          provider: m.provider,
          slug: `${m.provider}/${m.id}`,
          levels: piLevels(m),
        })),
      ],
    })
  }

  async function authRoute(req: Request, path: string) {
    const url = new URL(req.url)
    if (path === 'mode') return json(signIn)
    if (path === 'mcp/callback' && req.method === 'GET') return mcpCallback(req)
    if (path === 'logout' && req.method === 'POST') {
      const headers = new Headers({ 'set-cookie': clearSessionCookie })
      if (accounts) {
        // Better Auth ends its session and clears its own cookies.
        const signOut = await accounts.handle(
          new Request(new URL(`${ACCOUNT_PATH}/sign-out`, req.url), {
            method: 'POST',
            headers: req.headers,
          }),
        )
        for (const cookie of signOut.headers.getSetCookie()) headers.append('set-cookie', cookie)
      }
      return new Response(null, { status: 204, headers })
    }
    if (accounts && `/auth/${path}`.startsWith(`${ACCOUNT_PATH}/`)) return accounts.handle(req)
    if (config.auth.kind !== 'oidc') return error(404, 'unknown route')
    const oidc = config.auth
    const discovery = await discover(oidc.issuer)
    if (path === 'oidc') {
      const request = await authorizationRequest(discovery, oidc)
      const state = await sign(config.sessionSecret, {
        state: request.state,
        verifier: request.verifier,
        exp: Date.now() + 10 * 60_000,
      })
      return new Response(null, {
        status: 302,
        headers: {
          location: request.url,
          'set-cookie': `${OIDC_COOKIE}=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      })
    }
    if (path === 'callback') {
      const saved = await verify<{ state: string; verifier: string; exp: number }>(
        config.sessionSecret,
        readCookie(req, OIDC_COOKIE) ?? '',
      )
      const code = url.searchParams.get('code')
      if (
        !saved ||
        saved.exp < Date.now() ||
        saved.state !== url.searchParams.get('state') ||
        !code
      ) {
        return error(400, 'invalid sign-in callback')
      }
      const idToken = await exchangeCode(discovery, oidc, code, saved.verifier)
      const profile = await oidcVerifier({
        issuer: oidc.issuer,
        audience: oidc.clientId,
        ...(oidc.orgsClaim ? { orgsClaim: oidc.orgsClaim } : {}),
        ...(oidc.rolesClaim ? { rolesClaim: oidc.rolesClaim } : {}),
      })(idToken)
      const userId = await repo.link(profile)
      const headers = new Headers({ location: '/' })
      headers.append('set-cookie', await sessionCookie(config.sessionSecret, userId))
      headers.append('set-cookie', `${OIDC_COOKIE}=; Path=/auth; Max-Age=0`)
      return new Response(null, { status: 302, headers })
    }
    return error(404, 'unknown route')
  }

  /** `/api/*` and `/auth/*` routes; `null` for any other address. */
  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'auth') return authRoute(req, parts.slice(1).join('/'))
    if (parts[0] !== 'api') return null
    const principal = await principalOf(req)
    if (!principal) return error(401, 'authentication required')
    const [, section, ...rest] = parts
    if (section === 'admin') {
      return principal.scopes.includes(ADMIN_ROLE)
        ? adminRoute(req, rest)
        : error(403, 'admin only')
    }
    // The admin token has no conversations, nor has an organization key.
    if (
      principal.id === 'admin' ||
      (principal.kind !== 'user' && !(await repo.principal(principal.id)))
    ) {
      return error(403, 'an account was expected')
    }
    if (section === 'me') return json(await me(req))
    if (section === 'shapes' && platform.rows) {
      const table = rest[0]
      if (table === 'conversations') return platform.rows(req, table, { owner: principal.id })
      if (table === 'items' || table === 'item_chunks' || table === 'model_calls') {
        const conversation = await ownConversation(principal, url.searchParams.get('conversation'))
        if (!conversation) return error(404, 'conversation not found')
        return platform.rows(req, table, { owner: principal.id, conversationId: conversation.id })
      }
      return error(404, 'unknown shape')
    }
    if (section === 'live' && rest[0] && platform.live) {
      const conversation = await ownConversation(principal, rest[0])
      if (!conversation) return error(404, 'conversation not found')
      return platform.live(req, conversation.id)
    }
    if (section === 'commands' && req.method === 'POST') return command(req, principal)
    if (section === 'conversations' && rest.length === 0 && req.method === 'GET') {
      return json(await index.list(principal.id))
    }
    if (section === 'conversations' && rest.length === 0 && req.method === 'POST') {
      return createConversation(req, principal)
    }
    if (section === 'conversations' && rest[0] && req.method === 'PATCH') {
      return updateConversation(req, principal, rest[0])
    }
    if (section === 'conversations' && rest[0] && req.method === 'DELETE') {
      return deleteConversation(principal, rest[0])
    }
    if (section === 'credentials') return credentialsRoute(req, principal, rest)
    if (section === 'models' && req.method === 'GET') return modelsRoute(principal)
    if (section === 'mcp') return mcpRoute(req, principal, rest)
    if (section === 'skills') return skillsRoute(req, principal, rest[0])
    if (section === 'keys') return keysRoute(req, principal, rest[0])
    if (section === 'contributor') return contributorRoute(req, principal)
    return error(404, 'unknown route')
  }

  /**
   * Whether the account gives its conversations to the commons. Giving is the person's own act:
   * only a browser session changes it, never a key.
   */
  async function contributorRoute(req: Request, principal: Principal) {
    if (req.method === 'GET') return json({ on: await repo.contributor(principal.id) })
    if (req.method !== 'PUT') return error(404, 'unknown route')
    if (principal.kind !== 'user') return error(403, 'a browser session was expected')
    const body = (await req.json().catch(() => ({}))) as { on?: unknown }
    if (typeof body.on !== 'boolean') return error(400, 'on: a boolean was expected')
    await repo.setContributor(principal.id, body.on)
    return json({ on: body.on })
  }

  /**
   * API keys of the account, for scripts. Only a browser session manages them: a key never
   * creates another key.
   */
  async function keysRoute(req: Request, principal: Principal, id: string | undefined) {
    if (principal.kind !== 'user') return error(403, 'a browser session was expected')
    if (!id && req.method === 'GET') return json(await repo.apiKeys(principal.id))
    if (!id && req.method === 'POST') {
      const token = await repo.createApiKey({ userId: principal.id }, [API_KEY_SCOPE])
      return json({ token }, 201)
    }
    if (id && req.method === 'DELETE') {
      const revoked = await repo.revokeApiKey(principal.id, id)
      return revoked ? new Response(null, { status: 204 }) : error(404, 'key not found')
    }
    return error(404, 'unknown route')
  }

  /** Skills that the account sees, and the ones it publishes. */
  async function skillsRoute(req: Request, principal: Principal, id: string | undefined) {
    if (!id && req.method === 'GET') {
      const visible = await data.skills.visible(principal.id)
      return json({
        skills: visible.map((s) => ({ ...s, removable: mayRemove(principal, s) })),
        organizations: await repo.organizations(principal.id),
      })
    }
    if (!id && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        name?: unknown
        description?: unknown
        body?: unknown
        visibility?: unknown
        organizationId?: unknown
      }
      const visibility = body.visibility as SkillVisibility
      const organizationId = typeof body.organizationId === 'string' ? body.organizationId : null
      if (!VISIBILITIES.includes(visibility)) {
        return error(400, 'visibility: private, organization or instance was expected')
      }
      if (
        typeof body.name !== 'string' ||
        typeof body.description !== 'string' ||
        typeof body.body !== 'string'
      ) {
        return error(400, 'a name, a description and instructions were expected')
      }
      if (!mayPublish(principal, visibility, organizationId)) {
        return error(403, 'you cannot publish a skill there')
      }
      const skill = {
        name: body.name,
        description: body.description.trim(),
        body: body.body.trim(),
      }
      const problem = skillProblem(skill)
      if (problem) return error(400, problem)
      const created = await data.skills.create({
        ...skill,
        ownerId: principal.id,
        organizationId,
        visibility,
      })
      if (created === 'name_taken') return error(409, 'a skill there already has this name')
      return json(created, 201)
    }
    if (id && req.method === 'DELETE') {
      const skill = await data.skills.get(id)
      if (!skill) return error(404, 'skill not found')
      if (!mayRemove(principal, skill)) return error(403, 'only its creator or an admin removes it')
      await data.skills.delete(id)
      return new Response(null, { status: 204 })
    }
    return error(404, 'unknown route')
  }

  /** The tool servers of an account: from the catalog, or its own at a public address. */
  async function mcpRoute(req: Request, principal: Principal, rest: string[]) {
    const [id, action] = rest
    if (!id && req.method === 'GET') {
      return json({
        catalog: await data.mcp.catalog(),
        connections: await data.mcp.connections(principal.id),
      })
    }
    if (!id && req.method === 'POST') return addMcpServer(req, principal)
    const connection = id ? await data.mcp.connection(id) : null
    if (!connection || connection.userId !== principal.id)
      return error(404, 'tool server not found')
    if (action === 'sign-in' && req.method === 'POST') {
      if (connection.auth !== 'oauth') return error(400, 'this tool server has no sign-in')
      return mcpSignIn(req, principal, connection)
    }
    if (!action && req.method === 'DELETE') {
      await data.mcp.disconnect(principal.id, connection.id)
      return new Response(null, { status: 204 })
    }
    return error(404, 'unknown route')
  }

  async function addMcpServer(req: Request, principal: Principal) {
    const body = (await req.json().catch(() => ({}))) as {
      catalogId?: unknown
      name?: unknown
      url?: unknown
      auth?: unknown
      token?: unknown
    }
    const kind = body.auth as McpAuth
    if (!MCP_AUTHS.includes(kind)) return error(400, 'auth: none, token or oauth was expected')
    if (kind === 'token' && (typeof body.token !== 'string' || !body.token.trim())) {
      return error(400, 'a token was expected')
    }
    let server: { name: string; url: string; catalogId: string | null }
    if (typeof body.catalogId === 'string') {
      const entry = await data.mcp.catalogEntry(body.catalogId)
      if (!entry) return error(404, 'catalog entry not found')
      server = { name: entry.name, url: entry.url, catalogId: entry.id }
    } else {
      const url = httpUrl(body.url)
      if (typeof body.name !== 'string' || !MCP_NAME.test(body.name)) {
        return error(400, 'a name of lowercase letters, digits and dashes was expected')
      }
      if (!url) return error(400, 'an http or https address was expected')
      const problem = addressProblem(url)
      if (problem) return error(400, `this address is ${problem}`)
      server = { name: body.name, url, catalogId: null }
    }
    const connected = await data.mcp.connect({
      ...server,
      userId: principal.id,
      auth: kind,
      status: kind === 'oauth' ? 'sign_in' : 'connected',
      secret:
        kind === 'token'
          ? await mcp.seal({ kind: 'token', token: String(body.token).trim() })
          : null,
    })
    if (connected === 'name_taken')
      return error(409, 'you already have a tool server with this name')
    if (kind === 'oauth') return mcpSignIn(req, principal, connected)
    return json({ connection: connected, redirect: null }, 201)
  }

  /** Starts the OAuth sign-in; the state carries the connection and the account, signed. */
  async function mcpSignIn(req: Request, principal: Principal, connection: McpConnection) {
    const state = await sign(config.sessionSecret, {
      cid: connection.id,
      uid: principal.id,
      exp: Date.now() + SIGN_IN_MS,
      purpose: 'mcp',
    })
    try {
      const target = await mcp.startSignIn(
        connection,
        new URL(MCP_CALLBACK_PATH, req.url).toString(),
        state,
      )
      return json({
        connection: { ...connection, status: target ? 'sign_in' : 'connected' },
        redirect: target?.toString() ?? null,
      })
    } catch (e) {
      return error(
        502,
        `the sign-in to the tool server failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  /** Return of the OAuth sign-in of a tool server, in the browser of the person who started it. */
  async function mcpCallback(req: Request) {
    const url = new URL(req.url)
    const principal = await auth.authenticate(req)
    const state = await verify<{ cid: string; uid: string; exp: number; purpose: string }>(
      config.sessionSecret,
      url.searchParams.get('state') ?? '',
    )
    if (
      !principal ||
      !state ||
      state.purpose !== 'mcp' ||
      state.exp < Date.now() ||
      state.uid !== principal.id
    ) {
      return error(400, 'invalid sign-in callback')
    }
    const connection = await data.mcp.connection(state.cid)
    if (!connection || connection.userId !== principal.id)
      return error(404, 'tool server not found')
    const code = url.searchParams.get('code')
    if (!code) return redirect('/?settings=tools&toolServer=refused')
    try {
      await mcp.finishSignIn(connection, code, url.searchParams.get('iss'))
    } catch {
      return redirect('/?settings=tools&toolServer=failed')
    }
    return redirect('/?settings=tools&toolServer=connected')
  }

  /** Administration, for the admin token and the accounts with the admin role. */
  async function adminRoute(req: Request, rest: string[]) {
    if (rest[0] === 'mcp') return catalogRoute(req, rest[1])
    if (rest[0] !== 'accounts') return error(404, 'unknown route')
    const userId = rest[1]
    if (!userId && req.method === 'GET') return json(await repo.list())
    const body = (await req.json().catch(() => ({}))) as { admin?: unknown; password?: unknown }
    if (userId && rest[2] === 'admin' && req.method === 'POST') {
      if (typeof body.admin !== 'boolean') return error(400, 'admin: true or false was expected')
      const found = await repo.setAdmin(userId, body.admin)
      return found ? json({ ok: true }) : error(404, 'account not found')
    }
    if (userId && rest[2] === 'password' && req.method === 'POST') {
      if (!accounts) return error(404, 'the accounts are kept by another sign-in provider')
      const { password } = body
      if (
        typeof password !== 'string' ||
        password.length < PASSWORD_LENGTH.min ||
        password.length > PASSWORD_LENGTH.max
      ) {
        return error(
          400,
          `a password of ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters was expected`,
        )
      }
      const subject = await repo.subject(userId, BETTER_AUTH_PROVIDER)
      if (!subject) return error(404, 'this account has no password')
      await accounts.resetPassword(subject, password)
      return json({ ok: true })
    }
    return error(404, 'unknown route')
  }

  /** The tool server catalog: the servers that every account can connect. */
  async function catalogRoute(req: Request, id: string | undefined) {
    if (!id && req.method === 'GET') return json(await data.mcp.catalog())
    if (!id && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        name?: unknown
        url?: unknown
        description?: unknown
      }
      const url = httpUrl(body.url)
      if (typeof body.name !== 'string' || !MCP_NAME.test(body.name)) {
        return error(400, 'a name of lowercase letters, digits and dashes was expected')
      }
      if (!url) return error(400, 'an http or https address was expected')
      const added = await data.mcp.addToCatalog({
        name: body.name,
        url,
        description: typeof body.description === 'string' ? body.description.trim() : '',
      })
      if (added === 'name_taken')
        return error(409, 'the catalog already has a server with this name')
      return json(added, 201)
    }
    if (id && req.method === 'DELETE') {
      await data.mcp.removeFromCatalog(id)
      return new Response(null, { status: 204 })
    }
    return error(404, 'unknown route')
  }

  /** Account of the request, for the pages; `null` outside a session. */
  async function me(req: Request): Promise<Me | null> {
    const principal = await auth.authenticate(req)
    // An organization key has no row in `users`: it stays without an account.
    if (!principal || principal.id === 'admin') return null
    const name = await repo.displayName(principal.id)
    if (name === null) return null
    return {
      id: principal.id,
      name,
      auth: config.auth.kind,
      admin: principal.scopes.includes(ADMIN_ROLE),
    }
  }

  return { handle, me, principalOf, index, host, signIn }
}

export type HubServer = ReturnType<typeof hubServer>
