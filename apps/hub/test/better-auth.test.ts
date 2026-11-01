import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { betterAuthConnector } from '../src/server/better-auth.ts'
import { D1Accounts } from '../src/server/d1/accounts.ts'
import { d1AuthDatabase } from '../src/server/d1/auth.ts'
import type { Email } from '../src/server/email.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

const origin = 'https://hub.test'
const post = (path: string, body: unknown, cookie = '') =>
  new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify(body),
  })
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

async function connected(sent?: Email[]) {
  const d1 = d1Database()
  await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
  const db = drizzle(d1 as never)
  const repo = new D1Accounts(db)
  const accounts = betterAuthConnector(repo, {
    database: d1AuthDatabase(db),
    sessionSecret: 'a-session-secret-of-at-least-32-characters',
    ...(sent ? { email: { send: async (email: Email) => void sent.push(email) } } : {}),
  })
  return { d1, repo, accounts }
}

describe('accounts sign-in mode (Better Auth)', () => {
  // A person who creates an account must reach the same hub account on every later request,
  // and none once signed out; on D1, without transactions.
  it('links a new account to one hub account, until sign-out', async () => {
    const { d1, accounts } = await connected()

    const signUp = await accounts.handle(
      post('/auth/account/sign-up/email', {
        name: 'Ada',
        email: 'ada@hub.test',
        password: 'correct horse battery',
      }),
    )
    expect(signUp.status).toBe(200)
    const cookie = cookiesOf(signUp)
    const page = new Request(`${origin}/`, { headers: { cookie } })
    const first = await accounts.provider.authenticate(page)
    const second = await accounts.provider.authenticate(page)
    expect(first).toMatchObject({ kind: 'user' })
    expect(second?.id).toBe(first?.id)
    expect(d1.sqlite.prepare('SELECT provider, user_id FROM identities').all()).toEqual([
      { provider: 'better-auth', user_id: first?.id },
    ])

    const signIn = await accounts.handle(
      post('/auth/account/sign-in/email', {
        email: 'ada@hub.test',
        password: 'correct horse battery',
      }),
    )
    expect(signIn.status).toBe(200)
    const again = new Request(`${origin}/`, { headers: { cookie: cookiesOf(signIn) } })
    expect((await accounts.provider.authenticate(again))?.id).toBe(first?.id)

    expect((await accounts.handle(post('/auth/account/sign-out', {}, cookie))).status).toBe(200)
    expect(await accounts.provider.authenticate(page)).toBeNull()
  })

  // Without an email sender, an admin reset is the only way back into a forgotten account; it
  // must also close the sessions opened with the old password.
  it('replaces a password through an admin reset and ends the open sessions', async () => {
    const { repo, accounts } = await connected()
    const credentials = { email: 'ada@hub.test', password: 'correct horse battery' }
    const signUp = await accounts.handle(
      post('/auth/account/sign-up/email', { name: 'Ada', ...credentials }),
    )
    const page = new Request(`${origin}/`, { headers: { cookie: cookiesOf(signUp) } })
    const principal = await accounts.provider.authenticate(page)
    const subject = await repo.subject(principal?.id ?? '', 'better-auth')

    await accounts.resetPassword(subject ?? '', 'a new password')

    expect(await accounts.provider.authenticate(page)).toBeNull()
    const old = await accounts.handle(post('/auth/account/sign-in/email', credentials))
    expect(old.status).toBe(401)
    const renewed = await accounts.handle(
      post('/auth/account/sign-in/email', { ...credentials, password: 'a new password' }),
    )
    expect(renewed.status).toBe(200)
  })

  // With an email sender, an account signs in only after confirming its address, and a person
  // who forgot their password gets back in alone from the emailed link; the sessions opened
  // with the old password end.
  it('confirms the address before the first sign-in, then resets a forgotten password by email', async () => {
    const sent: Email[] = []
    const { accounts } = await connected(sent)
    const credentials = { email: 'ada@hub.test', password: 'correct horse battery' }
    const linkIn = (email: Email | undefined) => email?.text.match(/https:\/\/\S+/)?.[0] ?? ''
    const signIn = (password = credentials.password) =>
      accounts.handle(post('/auth/account/sign-in/email', { ...credentials, password }))

    const signUp = await accounts.handle(
      post('/auth/account/sign-up/email', { name: 'Ada', ...credentials, callbackURL: '/login' }),
    )
    expect(signUp.status).toBe(200)
    expect(cookiesOf(signUp)).not.toContain('session_token')
    expect((await signIn()).status).toBe(403)
    const confirmation = sent.find((e) => e.subject === 'Confirm your email address')
    expect(confirmation?.to).toBe('ada@hub.test')
    const confirmed = await accounts.handle(new Request(linkIn(confirmation)))
    expect(new URL(confirmed.headers.get('location') ?? '', origin).pathname).toBe('/login')
    const first = await signIn()
    expect(first.status).toBe(200)
    const page = new Request(`${origin}/`, { headers: { cookie: cookiesOf(first) } })
    expect(await accounts.provider.authenticate(page)).toMatchObject({ kind: 'user' })

    const request = await accounts.handle(
      post('/auth/account/request-password-reset', {
        email: credentials.email,
        redirectTo: '/reset-password',
      }),
    )
    expect(request.status).toBe(200)
    const reset = sent.at(-1)
    expect(reset?.subject).toBe('Reset your password')
    const landing = await accounts.handle(new Request(linkIn(reset)))
    const location = new URL(landing.headers.get('location') ?? '', origin)
    expect(location.pathname).toBe('/reset-password')
    const token = location.searchParams.get('token')

    const replaced = await accounts.handle(
      post('/auth/account/reset-password', { newPassword: 'a new password', token }),
    )
    expect(replaced.status).toBe(200)
    expect(await accounts.provider.authenticate(page)).toBeNull()
    expect((await signIn('a new password')).status).toBe(200)
  })
})
