// Subscription sign-in prompts on D1 (`credential_logins`).

import { and, eq } from 'drizzle-orm'

import type { SignInPrompts } from '../data.ts'
import type { D1Db } from './accounts.ts'
import { credentialLogins as logins } from './schema.ts'

export const d1SignInPrompts = (db: D1Db): SignInPrompts => ({
  async open(userId) {
    const id = crypto.randomUUID()
    await db.insert(logins).values({ id, userId })
    return id
  },
  async ask(loginId, prompt) {
    await db.update(logins).set({ prompt, answer: null }).where(eq(logins.id, loginId))
  },
  async answer(loginId) {
    const [row] = await db
      .select({ answer: logins.answer })
      .from(logins)
      .where(eq(logins.id, loginId))
    return row?.answer ?? null
  },
  async reply(userId, loginId, answer) {
    const updated = await db
      .update(logins)
      .set({ answer })
      .where(and(eq(logins.id, loginId), eq(logins.userId, userId)))
      .returning({ id: logins.id })
    return updated.length > 0
  },
  async close(loginId) {
    await db.delete(logins).where(eq(logins.id, loginId))
  },
})
