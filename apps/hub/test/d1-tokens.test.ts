import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { instanceKey } from '../src/server/crypto.ts'
import type { PiCredential } from '../src/server/data.ts'
import { d1TokenRows } from '../src/server/d1/tokens.ts'
import { users } from '../src/server/d1/schema.ts'
import { modelTokens } from '../src/server/tokens.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

const expired = { type: 'oauth', refresh: 'r0', access: 'a0', expires: 0 } as PiCredential

describe('model tokens on D1', () => {
  // A subscription token is refreshed once: a second refresh with the same refresh token is
  // refused by the provider, and would sign the person out.
  it('lets one turn refresh a token while the other waits and reads the refreshed one', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const db = drizzle(d1 as never)
    await db.insert(users).values({ id: 'u1', displayName: 'Ada' })
    const tokens = modelTokens(d1TokenRows(db), instanceKey(Buffer.alloc(32, 7).toString('base64')))
    const person = tokens.forUser('u1')
    await person.modify('anthropic', async () => expired)

    let refreshes = 0
    const refreshIfExpired = async (current: PiCredential | undefined) => {
      if (!current || current.type !== 'oauth' || current.expires > Date.now()) return undefined
      refreshes += 1
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { ...current, access: 'a1', expires: Date.now() + 3_600_000 }
    }
    const [first, second] = await Promise.all([
      person.modify('anthropic', refreshIfExpired),
      person.modify('anthropic', refreshIfExpired),
    ])

    expect(refreshes).toBe(1)
    expect(first).toMatchObject({ access: 'a1' })
    expect(second).toMatchObject({ access: 'a1' })
    expect(await person.read('anthropic')).toMatchObject({ access: 'a1' })
    expect(d1.sqlite.prepare('SELECT refreshing_until FROM model_credentials').all()).toEqual([
      { refreshing_until: null },
    ])
  })
})
