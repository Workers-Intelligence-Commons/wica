import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { sha256Hex } from '../src/server/crypto.ts'
import { D1Accounts } from '../src/server/d1/accounts.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

describe('API keys of an account', () => {
  // A script with a key acts as the account, never with its admin role; the key stops working
  // once its owner revokes it, and no other account can revoke it.
  it('acts as its account without the admin role until its owner revokes it', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const accounts = new D1Accounts(drizzle(d1 as never))
    const ada = await accounts.link({ provider: 'better-auth', subject: 's1', name: 'Ada' })
    const grace = await accounts.link({ provider: 'better-auth', subject: 's2', name: 'Grace' })
    await accounts.setAdmin(ada, true)

    const token = await accounts.createApiKey({ userId: ada }, ['chat'])
    const principal = await accounts.apiKey(await sha256Hex(token))
    expect(principal).toMatchObject({ id: ada, kind: 'apiKey', scopes: ['chat'] })
    const [key] = await accounts.apiKeys(ada)
    expect(await accounts.apiKeys(grace)).toEqual([])
    expect(JSON.stringify(key)).not.toContain(token)

    expect(await accounts.revokeApiKey(grace, key?.id ?? '')).toBe(false)
    expect(await accounts.apiKey(await sha256Hex(token))).not.toBeNull()
    expect(await accounts.revokeApiKey(ada, key?.id ?? '')).toBe(true)
    expect(await accounts.apiKey(await sha256Hex(token))).toBeNull()
    expect(await accounts.apiKeys(ada)).toEqual([])
  })
})
