import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { blocks, inline } from '../src/embed/format.ts'
import { hubServer } from '../src/server/app.ts'
import type { HubConfig } from '../src/server/config.ts'
import { D1Accounts } from '../src/server/d1/accounts.ts'
import { d1AuthDatabase } from '../src/server/d1/auth.ts'
import { d1ConversationIndex } from '../src/server/d1/conversations.ts'
import { d1Guests } from '../src/server/d1/guests.ts'
import type { ConversationHost } from '../src/server/data.ts'
import { sessionCookie } from '../src/server/identity.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

const hubOrigin = 'https://hub.test'
const asso = 'https://asso.example'
const config: HubConfig = {
  storage: { kind: 'cloudflare' },
  sessionSecret: 'a-session-secret-of-at-least-32-characters',
  instanceKey: Buffer.alloc(32).toString('base64'),
  auth: { kind: 'accounts' },
  model: { url: 'https://model.test', id: 'wpt' },
  testModels: false,
  guests: { dailyLimit: 20 },
  embed: { origins: [asso] },
}

/** The hub over D1, as on Workers; the live socket only answers that it was reached. */
async function hub() {
  const d1 = d1Database()
  await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
  const db = drizzle(d1 as never)
  const accounts = new D1Accounts(db)
  const index = d1ConversationIndex(db)
  const host: ConversationHost = {
    command: async () => ({ kind: 'acked', ack: { ok: true } }),
    wake: async () => {},
    read: async () => ({ head: null, items: [], chunks: [], calls: [] }),
    erase: async () => {},
  }
  const server = hubServer(
    config,
    {
      accounts,
      index,
      host,
      tokens: {} as never,
      prompts: {} as never,
      authDatabase: d1AuthDatabase(db),
      mcp: {} as never,
      mcpAccess: {} as never,
      skills: {} as never,
      guests: d1Guests(db),
    },
    { clientAddress: () => '203.0.113.7', live: async () => new Response('live socket') },
  )
  const call = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    (await server.handle(
      new Request(`${hubOrigin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )) as Response
  const guestKey = async () => {
    const key = (await (await call('POST', '/api/guest')).json()) as { id: string; secret: string }
    return { id: key.id, header: `${key.id}.${key.secret}` }
  }
  return { accounts, index, call, guestKey }
}

describe('the guest chat on another site', () => {
  // A site the hub lists may call the guest routes from its pages: the browser reads the answer
  // only when the hub names that site, and the component reads its harness session and the
  // position of each shape from the response headers.
  it('opens the guest routes to a listed site', async () => {
    const { call } = await hub()
    const preflight = await call('OPTIONS', '/api/commands', {
      origin: asso,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-wica-guest',
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(asso)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-wica-guest')

    const created = await call('POST', '/api/guest', { origin: asso })
    expect(created.status).toBe(201)
    expect(created.headers.get('access-control-allow-origin')).toBe(asso)
    expect(created.headers.get('access-control-expose-headers')).toContain('x-wica-session')
    expect(created.headers.get('vary')).toContain('Origin')
    expect(await (await call('GET', '/api/embed', { origin: asso })).json()).toEqual({
      sync: 'socket',
    })
  })

  // Any other site gets no permission, so the browser keeps the answers from it, and cannot
  // open the live socket of a conversation from its pages.
  it('stays closed to a site the hub does not list', async () => {
    const { call } = await hub()
    const other = { origin: 'https://elsewhere.example' }
    expect(
      (await call('OPTIONS', '/api/commands', other)).headers.has('access-control-allow-origin'),
    ).toBe(false)
    expect(
      (await call('POST', '/api/guest', other)).headers.has('access-control-allow-origin'),
    ).toBe(false)
    expect((await call('GET', '/api/live/c1?ticket=t', other)).status).toBe(403)
    expect(await (await call('GET', '/api/live/c1?ticket=t', { origin: asso })).text()).not.toBe('')
  })

  // A listed site's page may send the hub's cookies when both sit under one domain: the hub then
  // answers as to a guest, never as the account, and account routes stay closed to the site.
  it('never answers a listed site as an account', async () => {
    const { call, accounts } = await hub()
    const ada = await accounts.link({ provider: 'test', subject: 'ada', name: 'Ada' })
    const cookie = (await sessionCookie(config.sessionSecret, ada)).split(';')[0] as string
    expect((await call('GET', '/api/conversations', { cookie })).status).toBe(200)
    expect((await call('GET', '/api/conversations', { cookie, origin: asso })).status).toBe(401)
    const me = await call('GET', '/api/me', { cookie, origin: asso })
    expect(me.headers.has('access-control-allow-origin')).toBe(false)
  })

  // "Continue on the hub" hands the component's key to a browser that already has its own guest
  // key there: the handed key's conversations join that key, which proves it holds both secrets.
  it('merges a handed-over guest key into the one the hub already knows', async () => {
    const { call, guestKey, index } = await hub()
    const handed = await guestKey()
    const kept = await guestKey()
    const created = await call('POST', '/api/conversations', { 'x-wica-guest': handed.header }, {})
    const { id } = (await created.json()) as { id: string }

    const forged = `${handed.id}.guest_wrong`
    expect(
      (await call('POST', '/api/guest/merge', { 'x-wica-guest': kept.header }, { key: forged }))
        .status,
    ).toBe(404)
    expect(
      (
        await call(
          'POST',
          '/api/guest/merge',
          { 'x-wica-guest': kept.header },
          { key: handed.header },
        )
      ).status,
    ).toBe(204)
    expect(await index.get(id)).toMatchObject({ ownerId: null, guestId: kept.id })
    expect(
      (await call('GET', '/api/conversations', { 'x-wica-guest': handed.header })).status,
    ).toBe(401)
  })
})

describe('text formatting of the guest chat', () => {
  // The component writes model text into another site's page: markup in a message stays text,
  // and a link keeps only an http or https address.
  it('keeps markup as text and links only to web addresses', () => {
    for (const text of ['<img src=x onerror="alert(1)">', '[click](javascript:alert(1))']) {
      const parts = inline(text)
      expect(parts.every((p) => p.t === 'text')).toBe(true)
      expect(parts.map((p) => (p.t === 'text' ? p.v : '')).join('')).toBe(text)
    }
    expect(inline('see [the docs](https://wic.example/docs).')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://wic.example/docs', c: [{ t: 'text', v: 'the docs' }] },
      { t: 'text', v: '.' },
    ])
  })

  it('reads paragraphs, lists, code and emphasis', () => {
    expect(blocks('**Hello** and `x`\n\n- one\n- two\n\n```\nlet a = 1\n```')).toEqual([
      {
        t: 'p',
        c: [
          { t: 'strong', c: [{ t: 'text', v: 'Hello' }] },
          { t: 'text', v: ' and ' },
          { t: 'code', v: 'x' },
        ],
      },
      { t: 'ul', items: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]] },
      { t: 'pre', v: 'let a = 1' },
    ])
  })
})
