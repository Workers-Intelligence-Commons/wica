// Chat server: the HTTP routes of the application around the embedded Harness server. Each
// browser command is placed in `commands`; a conversation of the embedded server processes it in
// the request with a short turn, then the rest leaves as a wake-up. A conversation of a remote
// server waits for that server to read it from its command inbox.

import { dispatchStoreCall, isStoreCall, callConversation } from '@wica/chat-remote'
import type { Envelope } from '@wica/protocol'
import {
  type Authorize,
  type ClientAuth,
  createHarness,
  isDestructive,
  isOpenWorld,
  type ModelAdapter,
  type Scheduler,
  scheduleTools,
} from '@wica/runtime'
import { renderAnswer, userTools } from '@wica/tools-user'
import type postgres from 'postgres'

import type { ChatConfig } from './config.ts'
import { instanceKey, sign, verify } from './crypto.ts'
import { PgSessionStore } from './hosting.ts'
import {
  appAuth,
  authorizationRequest,
  type AuthProvider,
  bootstrapAuth,
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
import { createServer, PgIdentityRepo, serverByToken, uuidv7 } from './identity-pg.ts'
import {
  answerLogin,
  conversationModel,
  listProviders,
  loginFlow,
  parseModelChoice,
  testModelOptions,
  userModels,
} from './models.ts'
import { oneShot } from './one-shot.ts'
import { proxiedResponse, type ShapeName, shapeSpec, upstreamUrl } from './shapes.ts'
import { PgStore } from './store.ts'

export type Platform = {
  scheduler: Scheduler
  /** Address of the incoming connection, for the trusted proxy. */
  clientAddress: (req: Request) => string | undefined
  /** Budget of a turn before handing back control and asking for a resume. */
  turnBudgetMs?: number
}

const INSTRUCTIONS =
  'You are the assistant of a chat. Answer the person in the conversation, and ask your questions with ask_user. You have no access to the file system or to a terminal.'

/** The embedded server has only tools without system access: they pass without a request. */
const chatAuthorize: Authorize = (call) =>
  !isDestructive(call.annotations) && !isOpenWorld(call.annotations)
    ? 'allow'
    : { ask: `Allow ${call.tool}?` }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const error = (status: number, message: string) => json({ error: message }, status)

const COMMAND_TOKEN_MS = 60_000
const OIDC_COOKIE = 'wica_oidc'

type ConversationRow = { owner_id: string | null; server_id: string | null; model: string | null }

/** A model that cannot be found does not stop the command from being written; the long turn reports it. */
const unavailableModel = (message: string): ModelAdapter => ({
  stream: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(message)) }),
  }),
})

export function chatServer(config: ChatConfig, sql: postgres.Sql, platform: Platform) {
  const store = new PgStore(sql)
  const sessions = new PgSessionStore(sql)
  const repo = new PgIdentityRepo(sql)
  const key = instanceKey(config.instanceKey)

  let adapter: AuthProvider | undefined
  if (config.auth.kind === 'bootstrap' && config.adminToken)
    adapter = bootstrapAuth(config.adminToken)
  if (config.auth.kind === 'oidc') {
    adapter = oidcAuth(repo, { issuer: config.auth.issuer, audience: config.auth.clientId })
  }
  if (config.auth.kind === 'proxy') {
    adapter = trustedProxyAuth(repo, { ...config.auth, clientAddress: platform.clientAddress })
  }
  const auth = appAuth({
    repo,
    sessionSecret: config.sessionSecret,
    ...(adapter ? { adapter } : {}),
  })
  // The admin token stays valid in every mode, to create the first accounts.
  const admin = config.adminToken ? bootstrapAuth(config.adminToken) : undefined

  /** The embedded server recognizes the short token that a command request gives it. */
  const clientAuth: ClientAuth = {
    async authenticate({ token }) {
      const claims = token
        ? await verify<{ uid: string; exp: number; purpose: string }>(config.sessionSecret, token)
        : null
      if (!claims || claims.purpose !== 'command' || claims.exp < Date.now()) return null
      return {
        identity: { userId: claims.uid },
        from: { channel: 'web', author: claims.uid, trust: 'owner' },
      }
    },
    async canAccess(identity, conversationId) {
      const userId = (identity as { userId?: string }).userId
      const [row] = await sql<ConversationRow[]>`
        SELECT owner_id, server_id, model FROM conversations WHERE id = ${conversationId}`
      return Boolean(userId && row && row.owner_id === userId && row.server_id === null)
    },
  }

  async function harnessFor(conversationId: string) {
    const [row] = await sql<ConversationRow[]>`
      SELECT owner_id, server_id, model FROM conversations WHERE id = ${conversationId}`
    const choice = parseModelChoice(row?.model)
    let model: ModelAdapter
    try {
      if (!choice) throw new Error(`Unknown model: ${row?.model}`)
      model = conversationModel(config, sql, await key, row?.owner_id ?? null, choice)
    } catch (e) {
      model = unavailableModel(e instanceof Error ? e.message : String(e))
    }
    return createHarness({
      model,
      store,
      sessions,
      scheduler: platform.scheduler,
      auth: clientAuth,
      tools: [...userTools, ...scheduleTools],
      authorize: chatAuthorize,
      renderAnswer,
      instructions: INSTRUCTIONS,
      ...(platform.turnBudgetMs !== undefined ? { turnBudgetMs: platform.turnBudgetMs } : {}),
    })
  }

  /** Scheduled wake-up of a conversation: its next turn, on the embedded server. */
  async function wake(conversationId: string) {
    const [row] = await sql<ConversationRow[]>`
      SELECT owner_id, server_id, model FROM conversations WHERE id = ${conversationId}`
    if (!row || row.server_id !== null) return
    await (await harnessFor(conversationId)).wake(conversationId)
  }

  async function principalOf(req: Request): Promise<Principal | null> {
    return (await auth.authenticate(req)) ?? (admin ? admin.authenticate(req) : null)
  }

  async function ownConversation(principal: Principal, conversationId: string | null) {
    if (!conversationId) return null
    const [row] = await sql<(ConversationRow & { id: string })[]>`
      SELECT id, owner_id, server_id, model FROM conversations WHERE id = ${conversationId}`
    return row && row.owner_id === principal.id ? row : null
  }

  async function shape(req: Request, name: ShapeName, scope: Parameters<typeof shapeSpec>[1]) {
    const spec = shapeSpec(name, scope)
    if (!spec) return error(400, 'unknown shape')
    let upstream: Response
    try {
      upstream = await fetch(
        upstreamUrl(config.electricUrl, config.electricSecret, spec, new URL(req.url)),
        { signal: req.signal },
      )
    } catch {
      // A client that left closes its pending request: this is not a failure.
      if (req.signal.aborted) return new Response(null, { status: 499 })
      return error(502, 'sync unavailable')
    }
    return proxiedResponse(upstream)
  }

  async function command(req: Request, principal: Principal) {
    const envelope = (await req.json()) as Envelope
    if (envelope?.kind !== 'command' || typeof envelope.commandId !== 'string') {
      return error(400, 'a command was expected')
    }
    const conversation = await ownConversation(principal, envelope.conversationId)
    if (!conversation) return error(404, 'conversation not found')
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO commands (id, conversation_id, server_id, kind, payload)
      VALUES (${envelope.commandId}, ${conversation.id}, ${conversation.server_id},
              ${envelope.command.t}, ${sql.json(envelope as unknown as postgres.JSONValue)})
      ON CONFLICT (id) DO NOTHING
      RETURNING id`
    if (!inserted) {
      const [existing] = await sql<{ ack: unknown; conversation_id: string }[]>`
        SELECT ack, conversation_id FROM commands WHERE id = ${envelope.commandId}`
      if (existing?.conversation_id !== conversation.id)
        return error(409, 'this id is already taken')
      if (existing.ack) return json(existing.ack)
    }
    if (conversation.server_id !== null) return json({ ok: true, deposited: true }, 202)
    if (envelope.command.t === 'send') await autoTitle(conversation.id, envelope.command.parts)
    const token = await sign(config.sessionSecret, {
      uid: principal.id,
      exp: Date.now() + COMMAND_TOKEN_MS,
      purpose: 'command',
    })
    const harnessSession = req.headers.get('x-wica-session') ?? undefined
    const { transport, result } = oneShot(
      { token, ...(harnessSession ? { sessionId: harnessSession } : {}) },
      envelope,
    )
    const harness = await harnessFor(conversation.id)
    void harness.serve(transport)
    const { ack, sessionId } = await result
    const body = ack.ok ? { ok: true } : { ok: false, error: ack.error }
    await sql`
      UPDATE commands SET acked_at = now(), ack = ${sql.json(body)}
      WHERE id = ${envelope.commandId}`
    return json(body, ack.ok ? 200 : 422, { 'x-wica-session': sessionId })
  }

  async function autoTitle(conversationId: string, parts: { type: string; text?: string }[]) {
    const text = parts
      .flatMap((p) => (p.type === 'text' && p.text ? [p.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return
    await sql`
      UPDATE conversations SET title = ${text.length > 60 ? `${text.slice(0, 59)}…` : text}
      WHERE id = ${conversationId} AND title = ''`
  }

  async function createConversation(req: Request, principal: Principal) {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string
      serverId?: string | null
      model?: string | null
    }
    const choice = body.model ? parseModelChoice(body.model) : null
    if (body.model && (!choice || (choice.kind === 'lorem' && !config.testModels))) {
      return error(400, 'unknown model')
    }
    if (body.serverId) {
      const [server] = await sql`
        SELECT 1 FROM servers WHERE id = ${body.serverId} AND owner_id = ${principal.id}
          AND revoked_at IS NULL`
      if (!server) return error(404, 'server not found')
    }
    const id = uuidv7()
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const [row] = await sql.begin(async (tx) => {
      await tx`
        INSERT INTO conversations (id, owner_id, server_id, title, model, id_salt)
        VALUES (${id}, ${principal.id}, ${body.serverId ?? null}, ${body.title ?? ''},
                ${body.model ?? null}, ${salt})`
      await tx`INSERT INTO conversation_writers (conversation_id) VALUES (${id})`
      return tx<{ txid: string }[]>`SELECT pg_current_xact_id()::xid::text AS txid`
    })
    return json({ id, salt, txid: Number(row?.txid) }, 201)
  }

  async function deleteConversation(principal: Principal, conversationId: string) {
    const row = await ownConversation(principal, conversationId)
    if (!row) return error(404, 'conversation not found')
    await sql.begin(async (tx) => {
      await tx`DELETE FROM conversations WHERE id = ${conversationId}`
      // Garbage collection: a blob that no item references anymore is freed.
      await tx`
        DELETE FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.blob_sha256 = b.sha256)`
    })
    return new Response(null, { status: 204 })
  }

  async function remote(req: Request, path: string) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const server = await serverByToken(sql, token)
    if (!server) return error(401, 'server token refused')
    if (path === 'shapes/commands') {
      return shape(req, 'commands', { owner: server.ownerId, serverId: server.serverId })
    }
    if (req.method !== 'POST') return error(405, 'POST was expected')
    if (path === 'whoami') return json(server)
    if (path === 'heartbeat') {
      await sql`UPDATE servers SET last_seen_at = now() WHERE id = ${server.serverId}`
      return json({ ok: true })
    }
    if (path === 'ack') {
      const body = (await req.json()) as { commandId: string; result: unknown }
      await sql`
        UPDATE commands SET acked_at = COALESCE(acked_at, now()),
                            ack = COALESCE(ack, ${sql.json(body.result as postgres.JSONValue)})
        WHERE id = ${body.commandId} AND server_id = ${server.serverId}`
      return json({ ok: true })
    }
    if (path === 'store') {
      const call = (await req.json()) as unknown
      if (!isStoreCall(call)) return error(400, 'a Store call was expected')
      const conversationId = callConversation(call)
      const [row] = await sql<ConversationRow[]>`
        SELECT owner_id, server_id, model FROM conversations WHERE id = ${conversationId}`
      if (!row || row.server_id !== server.serverId || row.owner_id !== server.ownerId) {
        return error(403, 'this conversation belongs to another server')
      }
      return json(await dispatchStoreCall(store, call))
    }
    return error(404, 'unknown route')
  }

  async function credentialsRoute(req: Request, principal: Principal, rest: string[]) {
    const k = await key
    const { credentials, models } = userModels(sql, principal.id, k)
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
      const ok = await answerLogin(sql, principal.id, rest[1], body.answer ?? '')
      return ok ? json({ ok: true }) : error(404, 'sign-in not found')
    }
    if (rest[0] === 'login' && rest[1] && req.method === 'POST') {
      const provider = rest[1]
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for await (const event of loginFlow(sql, principal.id, k, provider, req.signal)) {
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
    const { models } = userModels(sql, principal.id, await key)
    const available = await models.getAvailable().catch(() => [])
    return json({
      default: config.model ? { id: null, name: config.model.id } : null,
      models: [
        ...(config.testModels ? testModelOptions() : []),
        ...available.map((m) => ({
          id: `pi:${m.provider}/${m.id}`,
          name: `${m.provider} · ${m.name}`,
        })),
      ],
    })
  }

  async function authRoute(req: Request, path: string) {
    const url = new URL(req.url)
    if (path === 'mode') return json({ kind: config.auth.kind })
    if (path === 'logout' && req.method === 'POST') {
      return new Response(null, { status: 204, headers: { 'set-cookie': clearSessionCookie } })
    }
    if (path === 'key' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { key?: string }
      const principal = body.key
        ? await auth.authenticate(
            new Request(req.url, { headers: { authorization: `Bearer ${body.key}` } }),
          )
        : null
      // Only an account key opens a browser session.
      if (!principal || principal.id === 'admin' || !(await repo.principal(principal.id))) {
        return error(401, 'key refused')
      }
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': await sessionCookie(config.sessionSecret, principal.id) },
      })
    }
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
    if (parts[1] === 'remote') return remote(req, parts.slice(2).join('/'))
    const principal = await principalOf(req)
    if (!principal) return error(401, 'authentication required')
    const [, section, ...rest] = parts
    if (section === 'admin' && rest[0] === 'users' && req.method === 'POST') {
      if (!principal.scopes.includes('admin')) return error(403, 'admin only')
      const body = (await req.json()) as { name?: string }
      const userId = await repo.createUser(body.name?.trim() || 'Account')
      return json({ userId, apiKey: await repo.createApiKey({ userId }, ['chat']) }, 201)
    }
    // The admin only creates accounts; an organization key has no conversations.
    if (
      principal.id === 'admin' ||
      (principal.kind !== 'user' && !(await repo.principal(principal.id)))
    ) {
      return error(403, 'an account was expected')
    }
    if (section === 'me') return json(await me(req))
    if (section === 'shapes') {
      const name = rest[0] as ShapeName
      if (name === 'conversations' || name === 'servers')
        return shape(req, name, { owner: principal.id })
      if (name === 'items' || name === 'item_chunks') {
        const conversation = await ownConversation(principal, url.searchParams.get('conversation'))
        if (!conversation) return error(404, 'conversation not found')
        return shape(req, name, { owner: principal.id, conversationId: conversation.id })
      }
      return error(404, 'unknown shape')
    }
    if (section === 'commands' && req.method === 'POST') return command(req, principal)
    if (section === 'conversations' && rest.length === 0 && req.method === 'POST') {
      return createConversation(req, principal)
    }
    if (section === 'conversations' && rest[0] && req.method === 'DELETE') {
      return deleteConversation(principal, rest[0])
    }
    if (section === 'servers' && rest.length === 0 && req.method === 'POST') {
      const body = (await req.json()) as { name?: string }
      return json(await createServer(sql, principal.id, body.name?.trim() || 'Server'), 201)
    }
    if (section === 'servers' && rest[0] && req.method === 'DELETE') {
      await sql`
        UPDATE servers SET revoked_at = now()
        WHERE id = ${rest[0]} AND owner_id = ${principal.id} AND revoked_at IS NULL`
      return new Response(null, { status: 204 })
    }
    if (section === 'credentials') return credentialsRoute(req, principal, rest)
    if (section === 'models' && req.method === 'GET') return modelsRoute(principal)
    return error(404, 'unknown route')
  }

  /** Account of the request, for the pages; `null` outside a session. */
  async function me(req: Request) {
    const principal = await auth.authenticate(req)
    // An organization key has no row in `users`: it stays without an account.
    if (!principal || principal.id === 'admin') return null
    const [user] = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM users WHERE id = ${principal.id}`
    return user ? { id: user.id, name: user.display_name, auth: config.auth.kind } : null
  }

  return { handle, wake, me, principalOf, sql, store, authMode: config.auth.kind }
}

export type ChatServer = ReturnType<typeof chatServer>
