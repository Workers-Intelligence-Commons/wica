// Connector of the `accounts` sign-in mode: Better Auth keeps the accounts (email and password),
// their sessions and their credentials in its own tables, and serves its routes under
// `/auth/account/`. Each request with a Better Auth session is linked to the hub account of that
// user through an `identities` row, as an external identity is.

import { sha256 } from '@wica/core'
import { betterAuth, type BetterAuthOptions } from 'better-auth'

import { PASSWORD_LENGTH } from '../shared/accounts.ts'
import type { EmailSender } from './email.ts'
import type { AuthProvider, IdentityRepo } from './identity.ts'

/** Storage of Better Auth: its Drizzle adapter, bound to the database of the platform. */
export type AuthDatabase = NonNullable<BetterAuthOptions['database']>

export const BETTER_AUTH_PROVIDER = 'better-auth'
export const ACCOUNT_PATH = '/auth/account'
/** Page where a person chooses a new password, from the link of the reset email. */
export const RESET_PASSWORD_PAGE = '/reset-password'

/** Model names of the Better Auth tables, the keys of the schema its Drizzle adapter receives. */
export const AUTH_MODELS = {
  user: 'auth_users',
  session: 'auth_sessions',
  account: 'auth_accounts',
  verification: 'auth_verifications',
} as const

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A secret of Better Auth's own, so that its signatures never stand for those of the hub. */
const derivedSecret = (sessionSecret: string) =>
  hex(sha256(new TextEncoder().encode(`better-auth:${sessionSecret}`)))

export function betterAuthConnector(
  repo: IdentityRepo,
  options: { database: AuthDatabase; sessionSecret: string; email?: EmailSender },
) {
  const { email } = options
  const auth = betterAuth({
    database: options.database,
    secret: derivedSecret(options.sessionSecret),
    basePath: ACCOUNT_PATH,
    // Anyone who reaches the instance may create an account. With an email sender, an account
    // signs in only once its address is confirmed from an emailed link, and a person resets a
    // forgotten password from an emailed link; a reset ends the sessions opened with the old
    // password.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
      ...(email
        ? {
            requireEmailVerification: true,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: ({ user, url }) =>
              email.send({
                to: user.email,
                subject: 'Reset your password',
                text: `Choose a new password for your account at this address, within an hour:\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
              }),
          }
        : {}),
    },
    ...(email
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: ({ user, url }) =>
              email.send({
                to: user.email,
                subject: 'Confirm your email address',
                text: `Confirm the address of your account by opening this address:\n\n${url}`,
              }),
          },
        }
      : {}),
    user: { modelName: AUTH_MODELS.user },
    session: { modelName: AUTH_MODELS.session },
    account: { modelName: AUTH_MODELS.account },
    verification: { modelName: AUTH_MODELS.verification },
    telemetry: { enabled: false },
  })

  const provider: AuthProvider = {
    async authenticate(req) {
      const found = await auth.api.getSession({ headers: req.headers })
      if (!found) return null
      const userId = await repo.link({
        provider: BETTER_AUTH_PROVIDER,
        subject: found.user.id,
        name: found.user.name,
      })
      const principal = await repo.principal(userId)
      // A Better Auth session is created at sign-in and keeps that time while it is renewed.
      return principal && { ...principal, signedInAt: new Date(found.session.createdAt).getTime() }
    },
  }

  /**
   * Replaces the password of the Better Auth user `subject` and ends its sessions: the person
   * signs in again with the new one.
   */
  async function resetPassword(subject: string, password: string) {
    const context = await auth.$context
    await context.internalAdapter.updatePassword(subject, await context.password.hash(password))
    await context.internalAdapter.deleteUserSessions(subject)
  }

  /** Deletes the Better Auth user `subject`, with its sessions and its password. */
  async function deleteUser(subject: string) {
    const context = await auth.$context
    await context.internalAdapter.deleteUserSessions(subject)
    await context.internalAdapter.deleteUser(subject)
  }

  return { handle: (req: Request) => auth.handler(req), provider, resetPassword, deleteUser }
}

export type BetterAuthConnector = ReturnType<typeof betterAuthConnector>
