import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { D1Accounts } from '../src/server/d1/accounts.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

describe('admin role', () => {
  // The administration routes admit a principal by its `admin` permission: granting the role
  // must give it on the next request, and removing it must take it away.
  it('gives the admin permission to an account while it holds the role', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const accounts = new D1Accounts(drizzle(d1 as never))
    const id = await accounts.link({ provider: 'better-auth', subject: 's1', name: 'Ada' })

    expect((await accounts.principal(id))?.scopes).toEqual(['chat'])
    expect(await accounts.setAdmin(id, true)).toBe(true)
    expect((await accounts.principal(id))?.scopes).toEqual(['chat', 'admin'])
    expect(await accounts.list()).toEqual([{ id, name: 'Ada', admin: true }])
    expect(await accounts.setAdmin(id, false)).toBe(true)
    expect((await accounts.principal(id))?.scopes).toEqual(['chat'])
    expect(await accounts.setAdmin('missing', true)).toBe(false)
  })
})
