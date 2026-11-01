import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { instanceKey } from '../src/server/crypto.ts'
import { d1McpServers } from '../src/server/d1/mcp.ts'
import { users } from '../src/server/d1/schema.ts'
import { mcpAccess, type OAuthSecret } from '../src/server/mcp.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

describe('tokens of the tool servers', () => {
  // An OAuth refresh token is used once: a second refresh with it is refused by the
  // authorization server, and the person would have to sign in again.
  it('lets one turn refresh a refused token while the other waits and reads the refreshed one', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const db = drizzle(d1 as never)
    await db.insert(users).values({ id: 'u1', displayName: 'Ada' })
    const servers = d1McpServers(db)

    let refreshes = 0
    const access = mcpAccess({
      servers,
      key: instanceKey(Buffer.alloc(32, 7).toString('base64')),
      publicFetch: fetch,
      refresh: async (_connection, secret) => {
        refreshes += 1
        await new Promise((resolve) => setTimeout(resolve, 400))
        return {
          ...secret,
          tokens: { access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1' },
        }
      },
    })
    const signedIn: OAuthSecret = {
      kind: 'oauth',
      redirectUrl: 'https://hub.example.org/auth/mcp/callback',
      tokens: { access_token: 'a0', token_type: 'Bearer', refresh_token: 'r0' },
    }
    const connection = await servers.connect({
      userId: 'u1',
      name: 'notes',
      url: 'https://mcp.example.org/mcp',
      catalogId: null,
      auth: 'oauth',
      status: 'connected',
      secret: await access.seal(signedIn),
    })
    if (connection === 'name_taken') throw new Error('unexpected')

    const [first, second] = await Promise.all([
      access.credentials.refresh(connection.id, 'a0'),
      access.credentials.refresh(connection.id, 'a0'),
    ])

    expect(refreshes).toBe(1)
    expect(first).toEqual({ token: 'a1' })
    expect(second).toEqual({ token: 'a1' })
    expect(await access.credentials.get(connection.id)).toEqual({ token: 'a1' })
    expect(d1.sqlite.prepare('SELECT refreshing_until FROM mcp_connections').all()).toEqual([
      { refreshing_until: null },
    ])
  })

  // A refresh slower than its lease lost it: the turn that took over decides the connection.
  it('keeps the token of the turn that took over when a slower refresh is refused', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const db = drizzle(d1 as never)
    await db.insert(users).values({ id: 'u1', displayName: 'Ada' })
    const servers = d1McpServers(db)

    let clock = 0
    let refuseSlow: (value: null) => void = () => {}
    let calls = 0
    const access = mcpAccess({
      servers,
      key: instanceKey(Buffer.alloc(32, 7).toString('base64')),
      publicFetch: fetch,
      now: () => clock,
      refresh: async (_connection, secret) => {
        calls += 1
        if (calls === 1) return new Promise<null>((resolve) => (refuseSlow = resolve))
        return { ...secret, tokens: { access_token: 'a1', token_type: 'Bearer' } }
      },
    })
    const connection = await servers.connect({
      userId: 'u1',
      name: 'notes',
      url: 'https://mcp.example.org/mcp',
      catalogId: null,
      auth: 'oauth',
      status: 'connected',
      secret: await access.seal({
        kind: 'oauth',
        redirectUrl: 'https://hub.example.org/auth/mcp/callback',
        tokens: { access_token: 'a0', token_type: 'Bearer', refresh_token: 'r0' },
      }),
    })
    if (connection === 'name_taken') throw new Error('unexpected')

    const slow = access.credentials.refresh(connection.id, 'a0')
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    clock = 31_000
    expect(await access.credentials.refresh(connection.id, 'a0')).toEqual({ token: 'a1' })
    refuseSlow(null)
    expect(await slow).toBeUndefined()

    expect((await servers.connection(connection.id))?.status).toBe('connected')
    expect(await access.credentials.get(connection.id)).toEqual({ token: 'a1' })
  })
})
