// Hub server: the HTTP routes of the application around the Harness. The routes check the
// session and the ownership, then hand each request to a data contract (see `data.ts`); a
// command becomes a short turn in the request, and the rest of the turn leaves as a wake-up.

import type { Envelope } from '@wica/protocol'

import { addressProblem } from './addresses.ts'
import type { HubConfig } from './config.ts'
import { randomToken, sha256Hex, sign, verify } from './crypto.ts'
import { embedding } from './embed/index.ts'
import {
  type Accounts,
  ADMIN_ROLE,
  type ConversationEntry,
  type ConversationHost,
  type ConversationIndex,
  type Guests,
  type McpAuth,
  type McpConnection,
  type McpServers,
  type SignInPrompts,
  type Owner,
  type Skills,
  type SkillVisibility,
  TRASH_MS,
} from './data.ts'
import {
  adminTokenAuth,
  appAuth,
  authorizationRequest,
  type AuthProvider,
  clearSessionCookie,
  discover,
  exchangeCode,
  freshSignIn,
  oidcAuth,
  oidcVerifier,
  type Principal,
  readCookie,
  sessionCookie,
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
import { consentKindsFor } from '../shared/consent.ts'
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
 * that `owner` owns it.
 */
export type SyncScope = { owner: Owner; conversationId?: string }

export type Platform = {
  /** Network address of the person, as the host saw it; counts the messages of guests. */
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
  guests: Guests
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const error = (status: number, message: string) => json({ error: message }, status)

const OIDC_COOKIE = 'wica_oidc'
/** Header of a guest's key: its identifier, a dot, its secret. */
const GUEST_HEADER = 'x-wica-guest'
/** Header of the fingerprint of the guest's browser, computed in the page once they agree. */
const FINGERPRINT_HEADER = 'x-wica-fingerprint'
/** A guest conversation that no one changes for this long is erased. */
const GUEST_IDLE_MS = 30 * 24 * 60 * 60_000
/** How long a ticket for the live socket of a guest conversation stays valid. */
const LIVE_TICKET_MS = 60_000
/** Commands that make the model answer, counted against a guest's daily messages. */
const COUNTED: ReadonlySet<string> = new Set(['send', 'regenerate'])
const TITLE_MAX = 200
const NAME_MAX = 80

const iso = (ms: number) => new Date(ms).toISOString()

/** A name typed by the person: trimmed, not empty, at most `max` characters. */
const nameOf = (value: unknown, max = NAME_MAX) => {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim()
  return name && name.length <= max ? name : null
}

/** A path inside the hub, to return to after a sign-in; never another site. */
const localPath = (value: string | null) =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/'

const owns = (owner: Owner, entry: ConversationEntry) =>
  owner.kind === 'user'
    ? entry.ownerId === owner.id
    : entry.ownerId === null && entry.guestId === owner.id
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
  const embed = embedding(config, { sync: platform.live ? 'socket' : 'shapes' })

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
  const signIn: SignIn = {
    kind: config.auth.kind,
    email: Boolean(accounts && platform.email),
    guests: Boolean(config.guests),
  }
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

  async function ownConversation(owner: Owner, conversationId: string | null) {
    if (!conversationId) return null
    const entry = await index.get(conversationId)
    return entry && owns(owner, entry) ? entry : null
  }

  /** The guest key of the request, when the instance accepts guests and the key is valid. */
  async function guestOf(req: Request): Promise<string | null> {
    if (!config.guests) return null
    const [id, secret] = (req.headers.get(GUEST_HEADER) ?? '').split('.')
    if (!id || !secret) return null
    return (await data.guests.verify(id, await sha256Hex(secret))) ? id : null
  }

  /**
   * Counts a guest's message under their key and under the fingerprint of their browser and
   * network; false once either has reached the daily limit.
   */
  async function guestAllowance(req: Request, guestId: string) {
    const fingerprint = req.headers.get(FINGERPRINT_HEADER)?.trim()
    if (!config.guests || !fingerprint) return false
    const address = platform.clientAddress(req) ?? ''
    const keys = [`g:${guestId}`, `f:${await sha256Hex(`${fingerprint}|${address}`)}`]
    return data.guests.count(keys, iso(Date.now()).slice(0, 10), config.guests.dailyLimit)
  }

  async function command(req: Request, owner: Owner) {
    const envelope = (await req.json()) as Envelope
    if (envelope?.kind !== 'command' || typeof envelope.commandId !== 'string') {
      return error(400, 'a command was expected')
    }
    const conversation = await ownConversation(owner, envelope.conversationId)
    if (!conversation) return error(404, 'conversation not found')
    if (conversation.trashed) return error(409, 'this conversation is in the trash')
    if (owner.kind === 'guest' && COUNTED.has(envelope.command.t)) {
      if (!(await guestAllowance(req, owner.id))) {
        return error(429, 'you have sent all the messages of the day; create an account for more')
      }
    }
    const harnessSession = req.headers.get('x-wica-session') ?? undefined
    const outcome = await host.command(envelope, {
      userId: owner.kind === 'user' ? owner.id : `guest:${owner.id}`,
      ...(harnessSession ? { harnessSession } : {}),
    })
    if (outcome.kind === 'conflict') return error(409, 'this id is already taken')
    if (envelope.command.t === 'send') {
      await autoTitle(conversation.id, envelope.command.parts)
      // A message accepted while its owner contributes gives the conversation, for good. A guest
      // never contributes.
      if (owner.kind === 'user' && outcome.ack.ok && (await repo.contributor(owner.id))) {
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

  /** A model a conversation may use: absent or `null` is the default model. */
  function knownModel(model: string | null | undefined) {
    if (!model) return true
    const choice = parseModelChoice(model)
    return choice !== null && !(choice.kind === 'lorem' && !config.testModels)
  }

  /** Erases a conversation: the journal first, so that erasing again finishes after a failure. */
  async function erase(conversationId: string) {
    await host.erase(conversationId)
    await index.delete(conversationId)
  }

  /**
   * The conversations of an account or a guest. A guest keeps the default model. Deleting puts a
   * conversation in the trash, or, given to the commons, hands it over to the commons; from the
   * trash, `forever` erases it at once.
   */
  async function conversationsRoute(req: Request, owner: Owner, rest: string[]) {
    const [id, action] = rest
    if (!id && req.method === 'GET') return json(await index.list(owner))
    if (!id && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { title?: unknown; model?: unknown }
      const model = owner.kind === 'guest' ? null : ((body.model as string | null) ?? null)
      if (!knownModel(model)) return error(400, 'unknown model')
      const title = typeof body.title === 'string' ? body.title.slice(0, TITLE_MAX) : ''
      return json(await index.create({ owner, title, model }), 201)
    }
    const conversation = id ? await ownConversation(owner, id) : null
    if (!conversation) return error(404, 'conversation not found')
    if (action === 'restore' && req.method === 'POST') {
      await index.restore(conversation.id)
      return new Response(null, { status: 204 })
    }
    if (action) return error(404, 'unknown route')
    if (req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { model?: unknown; title?: unknown }
      if ('model' in body) {
        const model = (body.model as string | null) ?? null
        if (owner.kind === 'guest' || !knownModel(model)) return error(400, 'unknown model')
        await index.setModel(conversation.id, model)
      }
      if ('title' in body) {
        const title = nameOf(body.title, TITLE_MAX)
        if (!title) return error(400, `a title of 1 to ${TITLE_MAX} characters was expected`)
        await index.setTitle(conversation.id, title)
      }
      return new Response(null, { status: 204 })
    }
    if (req.method === 'DELETE') {
      if (conversation.contributed) {
        await index.giveToCommons(conversation.id)
        return json({ outcome: 'given' })
      }
      if (conversation.trashed && new URL(req.url).searchParams.get('forever') === '1') {
        await erase(conversation.id)
        return json({ outcome: 'erased' })
      }
      await index.trash(conversation.id)
      return json({ outcome: 'trashed' })
    }
    return error(404, 'unknown route')
  }

  /**
   * Empties the trash and the conversations of guests that no one changed for a month: called
   * every hour by the host.
   */
  async function purge(now = Date.now()) {
    const ids = [
      ...(await index.trashedBefore(iso(now - TRASH_MS))),
      ...(await index.guestsIdleSince(iso(now - GUEST_IDLE_MS))),
    ]
    for (const id of ids) await erase(id)
    await data.guests.prune(iso(now - GUEST_IDLE_MS), iso(now - 24 * 60 * 60_000).slice(0, 10))
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

  /** The default model alone: a guest has no provider of their own. */
  function guestModels() {
    return { default: defaultModel(), models: [] }
  }

  function defaultModel(): ModelOption | null {
    return config.model
      ? {
          id: null,
          name: config.model.id,
          group: 'This instance',
          provider: 'wic',
          levels: INSTANCE_LEVELS,
        }
      : null
  }

  async function modelsRoute(principal: Principal) {
    const { models } = userModels(tokens, principal.id)
    const available = await models.getAvailable().catch(() => [])
    const providerNames = new Map(models.getProviders().map((p) => [p.id, p.name]))
    return json({
      default: defaultModel(),
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
      // `fresh` asks the issuer for a new sign-in even when it holds a session, before a deletion.
      const request = await authorizationRequest(
        discovery,
        oidc,
        url.searchParams.get('fresh') === '1',
      )
      const state = await sign(config.sessionSecret, {
        state: request.state,
        verifier: request.verifier,
        next: localPath(url.searchParams.get('next')),
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
      const saved = await verify<{ state: string; verifier: string; next?: string; exp: number }>(
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
      const headers = new Headers({ location: localPath(saved.next ?? null) })
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
    const [, section, ...rest] = parts
    return embed.serve(req, section, (r) => apiRoute(r, section, rest))
  }

  async function apiRoute(req: Request, section: string | undefined, rest: string[]) {
    if (section === 'embed' && req.method === 'GET') return embed.info()
    const principal = await principalOf(req)
    if (!principal) return guestRoute(req, section, rest)
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
    const owner: Owner = { kind: 'user', id: principal.id }
    if (section === 'me') return meRoute(req, principal)
    if (section === 'shapes' && platform.rows) return shapesRoute(req, owner, rest[0])
    if (section === 'live' && rest[0] && platform.live) {
      const conversation = await ownConversation(owner, rest[0])
      if (!conversation) return error(404, 'conversation not found')
      return platform.live(req, conversation.id)
    }
    if (section === 'commands' && req.method === 'POST') return command(req, owner)
    if (section === 'conversations') return conversationsRoute(req, owner, rest)
    if (section === 'credentials') return credentialsRoute(req, principal, rest)
    if (section === 'models' && req.method === 'GET') return modelsRoute(principal)
    if (section === 'mcp') return mcpRoute(req, principal, rest)
    if (section === 'skills') return skillsRoute(req, principal, rest[0])
    if (section === 'keys') return keysRoute(req, principal, rest[0])
    if (section === 'contributor') return contributorRoute(req, principal)
    if (section === 'consents') return consentsRoute(req, principal, rest[0])
    if (section === 'export' && req.method === 'GET') return exportRoute(principal)
    if (section === 'guest' && rest[0] === 'claim' && req.method === 'POST') {
      return claimRoute(req, principal)
    }
    return error(404, 'unknown route')
  }

  /** Rows of a table that the pages sync, for an account or a guest. */
  async function shapesRoute(req: Request, owner: Owner, table: string | undefined) {
    if (!platform.rows) return error(404, 'unknown shape')
    if (table === 'conversations') return platform.rows(req, table, { owner })
    if (table === 'items' || table === 'item_chunks' || table === 'model_calls') {
      const id = new URL(req.url).searchParams.get('conversation')
      const conversation = await ownConversation(owner, id)
      if (!conversation) return error(404, 'conversation not found')
      return platform.rows(req, table, { owner, conversationId: conversation.id })
    }
    return error(404, 'unknown shape')
  }

  /**
   * Requests without an account: a new guest key, then, with the key, the guest's own
   * conversations with the default model. The live socket of a guest conversation opens with a
   * short ticket, since a browser socket carries no header.
   */
  async function guestRoute(req: Request, section: string | undefined, rest: string[]) {
    if (!config.guests) return error(401, 'authentication required')
    if (section === 'guest' && rest.length === 0 && req.method === 'POST') {
      const secret = randomToken('guest')
      const id = await data.guests.create(await sha256Hex(secret))
      return json({ id, secret }, 201)
    }
    if (section === 'live' && rest[0] && platform.live) {
      const ticket = await verify<{ purpose: string; conversationId: string; exp: number }>(
        config.sessionSecret,
        new URL(req.url).searchParams.get('ticket') ?? '',
      )
      if (!ticket || ticket.purpose !== 'live' || ticket.exp < Date.now()) {
        return error(401, 'authentication required')
      }
      if (ticket.conversationId !== rest[0]) return error(404, 'conversation not found')
      return platform.live(req, rest[0])
    }
    const guestId = await guestOf(req)
    if (!guestId) return error(401, 'authentication required')
    const owner: Owner = { kind: 'guest', id: guestId }
    if (section === 'live-ticket' && rest[0] && req.method === 'POST') {
      const conversation = await ownConversation(owner, rest[0])
      if (!conversation) return error(404, 'conversation not found')
      const ticket = await sign(config.sessionSecret, {
        purpose: 'live',
        conversationId: conversation.id,
        exp: Date.now() + LIVE_TICKET_MS,
      })
      return json({ ticket })
    }
    if (section === 'shapes') return shapesRoute(req, owner, rest[0])
    if (section === 'commands' && req.method === 'POST') return command(req, owner)
    if (section === 'conversations') return conversationsRoute(req, owner, rest)
    if (section === 'models' && req.method === 'GET') return json(guestModels())
    if (section === 'guest' && rest[0] === 'merge' && req.method === 'POST') {
      return mergeGuest(req, guestId)
    }
    return error(401, 'authentication required')
  }

  /**
   * Another guest key, handed over from the component on another site, gives its conversations
   * to this one and is gone; its secret proves that the browser holds it.
   */
  async function mergeGuest(req: Request, guestId: string) {
    const body = (await req.json().catch(() => ({}))) as { key?: unknown }
    const [id, secret] = typeof body.key === 'string' ? body.key.split('.') : []
    if (!id || !secret || !(await data.guests.verify(id, await sha256Hex(secret)))) {
      return error(404, 'guest key not found')
    }
    if (id !== guestId) {
      await index.claim(id, { kind: 'guest', id: guestId })
      await data.guests.delete(id)
    }
    return new Response(null, { status: 204 })
  }

  /** The guest's conversations become the account's, and the guest key is gone. */
  async function claimRoute(req: Request, principal: Principal) {
    if (principal.kind !== 'user') return error(403, 'a browser session was expected')
    const guestId = await guestOf(req)
    if (!guestId) return error(404, 'guest key not found')
    await index.claim(guestId, { kind: 'user', id: principal.id })
    await data.guests.delete(guestId)
    return new Response(null, { status: 204 })
  }

  /** The account itself: who it is, its name, and its deletion. */
  async function meRoute(req: Request, principal: Principal) {
    if (req.method === 'GET') return json(await me(req))
    if (principal.kind !== 'user') return error(403, 'a browser session was expected')
    if (req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown }
      const name = nameOf(body.name)
      if (!name) return error(400, `a name of 1 to ${NAME_MAX} characters was expected`)
      await repo.rename(principal.id, name)
      return new Response(null, { status: 204 })
    }
    if (req.method === 'DELETE') return deleteAccount(req, principal)
    return error(404, 'unknown route')
  }

  /**
   * Deletes the account, after a sign-in of the last minutes. Its conversations given to the
   * commons stay there without an owner, since the dedication cannot be withdrawn; every other
   * one is erased. Then its sign-in, and everything else it holds, go.
   */
  async function deleteAccount(req: Request, principal: Principal) {
    if (!freshSignIn(principal)) return error(403, 'sign in again to delete the account')
    const owner: Owner = { kind: 'user', id: principal.id }
    for (const row of await index.list(owner)) {
      if (row.contributed_at) await index.giveToCommons(row.id)
      else await erase(row.id)
    }
    const headers = new Headers({ 'set-cookie': clearSessionCookie })
    if (accounts) {
      const subject = await repo.subject(principal.id, BETTER_AUTH_PROVIDER)
      if (subject) await accounts.deleteUser(subject)
      // Better Auth's cookies name a session that no longer exists: they are cleared as well.
      const signOut = await accounts.handle(
        new Request(new URL(`${ACCOUNT_PATH}/sign-out`, req.url), {
          method: 'POST',
          headers: req.headers,
        }),
      )
      for (const cookie of signOut.headers.getSetCookie()) headers.append('set-cookie', cookie)
    }
    await repo.deleteAccount(principal.id)
    return new Response(null, { status: 204, headers })
  }

  /** Everything the account holds, as one JSON file; never a secret, a token or a key hash. */
  async function exportRoute(principal: Principal) {
    if (principal.kind !== 'user') return error(403, 'a browser session was expected')
    const userId = principal.id
    const owner: Owner = { kind: 'user', id: userId }
    const conversations = []
    for (const row of await index.list(owner)) {
      const journal = await host.read(row.id)
      conversations.push({ ...row, items: journal.items, modelCalls: journal.calls })
    }
    const { credentials, models } = userModels(tokens, userId)
    const body = {
      exportedAt: new Date().toISOString(),
      account: {
        id: userId,
        name: await repo.displayName(userId),
        contributor: await repo.contributor(userId),
        organizations: await repo.organizations(userId),
        consents: await repo.consents(userId),
      },
      conversations,
      skills: (await data.skills.visible(userId)).filter((s) => s.ownerId === userId),
      apiKeys: await repo.apiKeys(userId),
      toolServers: (await data.mcp.connections(userId)).map(({ name, url, auth, status }) => ({
        name,
        url,
        auth,
        status,
      })),
      modelProviders: (await listProviders(models, credentials)).filter((p) => p.connected),
    }
    return new Response(JSON.stringify(body, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="wic-hub-${iso(Date.now()).slice(0, 10)}.json"`,
      },
    })
  }

  /** The account's answers to the kinds of consent that concern accounts. */
  async function consentsRoute(req: Request, principal: Principal, kind: string | undefined) {
    const kinds = consentKindsFor('account')
    if (!kind && req.method === 'GET') {
      const answers = await repo.consents(principal.id)
      return json(
        kinds.map((k) => ({ ...k, answer: answers.find((a) => a.kind === k.id) ?? null })),
      )
    }
    if (kind && req.method === 'PUT') {
      if (principal.kind !== 'user') return error(403, 'a browser session was expected')
      if (!kinds.some((k) => k.id === kind)) return error(404, 'unknown consent')
      const body = (await req.json().catch(() => ({}))) as { granted?: unknown }
      if (typeof body.granted !== 'boolean') return error(400, 'granted: a boolean was expected')
      await repo.setConsent(principal.id, kind, body.granted)
      return new Response(null, { status: 204 })
    }
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
      const body = (await req.json().catch(() => ({}))) as { name?: unknown }
      const name = body.name === undefined || body.name === '' ? '' : nameOf(body.name)
      if (name === null) return error(400, `a name of at most ${NAME_MAX} characters was expected`)
      const token = await repo.createApiKey({ userId: principal.id }, [API_KEY_SCOPE], name)
      return json({ token }, 201)
    }
    if (id && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown }
      const name = body.name === '' ? '' : nameOf(body.name)
      if (name === null) return error(400, `a name of at most ${NAME_MAX} characters was expected`)
      const renamed = await repo.renameApiKey(principal.id, id, name)
      return renamed ? new Response(null, { status: 204 }) : error(404, 'key not found')
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
    if (id && req.method === 'PATCH') {
      const skill = await data.skills.get(id)
      if (!skill) return error(404, 'skill not found')
      if (!mayRemove(principal, skill)) return error(403, 'only its creator or an admin edits it')
      const body = (await req.json().catch(() => ({}))) as {
        name?: unknown
        description?: unknown
        body?: unknown
      }
      if (
        typeof body.name !== 'string' ||
        typeof body.description !== 'string' ||
        typeof body.body !== 'string'
      ) {
        return error(400, 'a name, a description and instructions were expected')
      }
      const text = { name: body.name, description: body.description.trim(), body: body.body.trim() }
      const problem = skillProblem(text)
      if (problem) return error(400, problem)
      const updated = await data.skills.update(id, text)
      if (updated === 'name_taken') return error(409, 'a skill there already has this name')
      return json(updated)
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
    if (!action && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown }
      const name = nameOf(body.name)
      if (!name || !MCP_NAME.test(name)) return error(400, 'invalid tool server name')
      const renamed = await data.mcp.rename(principal.id, connection.id, name)
      if (renamed === 'name_taken') return error(409, 'another tool server has this name')
      return new Response(null, { status: 204 })
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
      signedInAt: principal.signedInAt ?? null,
    }
  }

  return { handle, me, principalOf, index, host, signIn, purge }
}

export type HubServer = ReturnType<typeof hubServer>
