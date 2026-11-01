import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { D1Accounts } from '../src/server/d1/accounts.ts'
import { d1ConversationIndex } from '../src/server/d1/conversations.ts'
import { conversations } from '../src/server/d1/schema.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

describe('contributing conversations to the commons', () => {
  // Nobody gives their conversations without turning it on, and a CC0 dedication cannot be
  // withdrawn: the stamp keeps the time of the first gift and survives switching off.
  it('starts off, and keeps the first stamp of a conversation once given', async () => {
    const d1 = d1Database()
    await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
    const db = drizzle(d1 as never)
    const accounts = new D1Accounts(db)
    const index = d1ConversationIndex(db)
    const ada = await accounts.link({ provider: 'better-auth', subject: 's1', name: 'Ada' })
    const { id } = await index.create({ owner: { kind: 'user', id: ada }, title: '', model: null })
    const stamp = async () => {
      const [row] = await db
        .select({ at: conversations.contributedAt })
        .from(conversations)
        .where(eq(conversations.id, id))
      return row?.at ?? null
    }

    expect(await accounts.contributor(ada)).toBe(false)
    expect(await stamp()).toBeNull()

    await accounts.setContributor(ada, true)
    expect(await accounts.contributor(ada)).toBe(true)
    await index.markContributed(id)
    const first = await stamp()
    expect(first).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 5))
    await index.markContributed(id)
    await accounts.setContributor(ada, false)
    expect(await accounts.contributor(ada)).toBe(false)
    expect(await stamp()).toBe(first)
  })
})
