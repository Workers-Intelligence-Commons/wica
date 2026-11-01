import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { hubServer } from '../src/server/app.ts'
import type { HubConfig } from '../src/server/config.ts'
import { D1Accounts } from '../src/server/d1/accounts.ts'
import { d1AuthDatabase } from '../src/server/d1/auth.ts'
import { d1ConversationIndex } from '../src/server/d1/conversations.ts'
import { d1Guests } from '../src/server/d1/guests.ts'
import { D1SessionStore } from '../src/server/d1/sessions.ts'
import type { ConversationHost } from '../src/server/data.ts'
import { sessionCookie } from '../src/server/identity.ts'
import { resumableSession } from '../src/server/turns.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

const origin = 'https://hub.test'
const config: HubConfig = {
  storage: { kind: 'cloudflare' },
  sessionSecret: 'a-session-secret-of-at-least-32-characters',
  instanceKey: Buffer.alloc(32).toString('base64'),
  auth: { kind: 'accounts' },
  model: { url: 'https://model.test', id: 'wpt' },
  testModels: false,
  guests: { dailyLimit: 2 },
}

/**
 * The hub over D1, as on Workers. The journal host only records what it is asked: erasing a
 * journal belongs to the host and is checked with it.
 */
async function hub() {
  const d1 = d1Database()
  await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
  const db = drizzle(d1 as never)
  const accounts = new D1Accounts(db)
  const index = d1ConversationIndex(db)
  const erased: string[] = []
  const host: ConversationHost = {
    command: async () => ({ kind: 'acked', ack: { ok: true } }),
    wake: async () => {},
    read: async () => ({ head: null, items: [], chunks: [], calls: [] }),
    erase: async (id) => void erased.push(id),
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
    { clientAddress: () => '203.0.113.7' },
  )
  const call = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    (await server.handle(
      new Request(`${origin}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )) as Response
  const signedIn = async (name: string, at = Date.now()) => {
    const id = await accounts.link({ provider: 'test', subject: name, name })
    const cookie = (await sessionCookie(config.sessionSecret, id, at)).split(';')[0] as string
    return { id, headers: { cookie } }
  }
  const send = (conversationId: string, headers: Record<string, string>) =>
    call('POST', '/api/commands', headers, {
      kind: 'command',
      sessionId: 's',
      commandId: crypto.randomUUID(),
      clientSeq: 1,
      conversationId,
      command: { t: 'send', parentId: null, parts: [{ type: 'text', text: 'hello' }] },
    })
  return { d1, accounts, index, erased, server, call, signedIn, send }
}

const created = async (response: Response) => ((await response.json()) as { id: string }).id

describe('deleting an account', () => {
  // The deletion is the person's own act: it asks for a recent sign-in. A CC0 dedication cannot be
  // withdrawn, so the conversations given to the commons outlive the account; the others go.
  it('needs a recent sign-in, keeps the contributed conversations and erases the others', async () => {
    const { call, signedIn, index, erased, accounts } = await hub()
    const stale = await signedIn('ada', Date.now() - 6 * 60_000)
    expect((await call('DELETE', '/api/me', stale.headers)).status).toBe(403)

    const ada = await signedIn('ada')
    const given = await created(await call('POST', '/api/conversations', ada.headers, {}))
    const kept = await created(await call('POST', '/api/conversations', ada.headers, {}))
    await index.markContributed(given)

    expect((await call('DELETE', '/api/me', ada.headers)).status).toBe(204)
    expect(await index.get(given)).toMatchObject({ ownerId: null, contributed: true })
    expect(await index.get(kept)).toBeNull()
    expect(erased).toEqual([kept])
    expect(await accounts.displayName(ada.id)).toBeNull()
  })
})

describe('the trash', () => {
  // A deleted conversation can be brought back for 30 days; meanwhile it takes no message, and
  // after that it is erased. One given to the commons leaves the owner's list instead.
  it('holds a conversation read-only until restored, then erases it 30 days later', async () => {
    const { call, signedIn, send, index, erased, server } = await hub()
    const ada = await signedIn('ada')
    const id = await created(await call('POST', '/api/conversations', ada.headers, {}))

    const deleted = await call('DELETE', `/api/conversations/${id}`, ada.headers)
    expect(await deleted.json()).toEqual({ outcome: 'trashed' })
    expect((await send(id, ada.headers)).status).toBe(409)
    expect((await call('POST', `/api/conversations/${id}/restore`, ada.headers)).status).toBe(204)
    expect((await send(id, ada.headers)).status).toBe(200)

    await call('DELETE', `/api/conversations/${id}`, ada.headers)
    await server.purge(Date.now() + 29 * 86_400_000)
    expect(await index.get(id)).not.toBeNull()
    await server.purge(Date.now() + 31 * 86_400_000)
    expect(await index.get(id)).toBeNull()
    expect(erased).toEqual([id])
  })

  it('hands a contributed conversation to the commons instead', async () => {
    const { call, signedIn, index } = await hub()
    const ada = await signedIn('ada')
    const id = await created(await call('POST', '/api/conversations', ada.headers, {}))
    await index.markContributed(id)
    const deleted = await call('DELETE', `/api/conversations/${id}`, ada.headers)
    expect(await deleted.json()).toEqual({ outcome: 'given' })
    expect(await index.get(id)).toMatchObject({ ownerId: null, guestId: null, trashed: false })
    expect(await index.list({ kind: 'user', id: ada.id })).toEqual([])
  })
})

describe('guests', () => {
  // A guest talks to the default model within the daily limit; signing in keeps what they wrote.
  it('are limited per day, and their conversations move to the account that signs in', async () => {
    const { call, signedIn, send, index } = await hub()
    const key = (await (await call('POST', '/api/guest')).json()) as { id: string; secret: string }
    const guest = { 'x-wica-guest': `${key.id}.${key.secret}`, 'x-wica-fingerprint': 'f1' }
    const id = await created(await call('POST', '/api/conversations', guest, { model: 'pi:x/y' }))
    expect(await index.get(id)).toMatchObject({ ownerId: null, guestId: key.id, model: null })

    expect((await send(id, guest)).status).toBe(200)
    expect((await send(id, guest)).status).toBe(200)
    expect((await send(id, guest)).status).toBe(429)
    // A new key in the same browser meets the same fingerprint and network.
    const again = (await (await call('POST', '/api/guest')).json()) as {
      id: string
      secret: string
    }
    const fresh = { ...guest, 'x-wica-guest': `${again.id}.${again.secret}` }
    const other = await created(await call('POST', '/api/conversations', fresh, {}))
    expect((await send(other, fresh)).status).toBe(429)

    const ada = await signedIn('ada')
    expect(
      (
        await call('POST', '/api/guest/claim', {
          ...ada.headers,
          'x-wica-guest': guest['x-wica-guest'],
        })
      ).status,
    ).toBe(204)
    expect(await index.get(id)).toMatchObject({ ownerId: ada.id, guestId: null })
    expect((await call('GET', '/api/conversations', guest)).status).toBe(401)
  })
})

describe('guest sessions', () => {
  // Each command of a guest opens a harness session as `guest:<key>`, which is no account: the
  // session must still be kept, or the command never gets its acknowledgement.
  it('keep the session of a guest, which has no account', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const sessions = new D1SessionStore(drizzle(d1 as never))
    const session = {
      id: 's1',
      identity: { userId: 'guest:01a19833-de63-783a-ac41-972ed56b49bc' },
      from: {
        channel: 'web',
        author: 'guest:01a19833-de63-783a-ac41-972ed56b49bc',
        trust: 'owner',
      },
      expiresAt: Date.now() + 60_000,
    } as const
    await sessions.put(session)
    expect(await sessions.get('s1')).toEqual(session)
  })

  // A tab keeps its harness session across a sign-in: the account must not resume the guest's
  // session, whose identity the harness would keep, and which may not reach the account's
  // conversations.
  it('are resumed only by the same person', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const sessions = new D1SessionStore(drizzle(d1 as never))
    const guest = 'guest:01a19833-de63-783a-ac41-972ed56b49bc'
    await sessions.put({
      id: 's1',
      identity: { userId: guest },
      from: { channel: 'web', author: guest, trust: 'owner' },
      expiresAt: Date.now() + 60_000,
    })
    expect(await resumableSession(sessions, 's1', guest)).toBe('s1')
    expect(await resumableSession(sessions, 's1', '01a19837-5574-708b-bf43-d6b014c009f9')).toBe(
      undefined,
    )
    expect(await resumableSession(sessions, 'unknown', guest)).toBe(undefined)
  })
})

describe('D1 migration of the data management', () => {
  // The migration rebuilds the conversations table so that a conversation may have no owner; the
  // conversations already there must come through it unchanged.
  it('keeps the conversations written before it', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const folder = new URL('../migrations/d1/', import.meta.url)
    const d1 = d1Database()
    const apply = (file: string) => {
      for (const statement of readFileSync(new URL(file, folder), 'utf8').split(
        '--> statement-breakpoint',
      )) {
        if (statement.trim()) d1.sqlite.exec(statement)
      }
    }
    const files = readdirSync(folder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const rebuild = files.findIndex((f) => f.startsWith('0006_'))
    for (const file of files.slice(0, rebuild)) apply(file)
    d1.sqlite.exec(`INSERT INTO users (id, display_name) VALUES ('u1', 'Ada')`)
    d1.sqlite.exec(
      `INSERT INTO conversations (id, owner_id, title, id_salt, contributed_at)
       VALUES ('c1', 'u1', 'Minutes', 'salt', '2026-11-01T00:00:00.000Z')`,
    )
    for (const file of files.slice(rebuild)) apply(file)
    expect(
      d1.sqlite
        .prepare(
          'SELECT id, owner_id, title, contributed_at, deleted_at, guest_id FROM conversations',
        )
        .all(),
    ).toEqual([
      {
        id: 'c1',
        owner_id: 'u1',
        title: 'Minutes',
        contributed_at: '2026-11-01T00:00:00.000Z',
        deleted_at: null,
        guest_id: null,
      },
    ])
  })
})
