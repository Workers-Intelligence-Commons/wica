// Storage of Better Auth on D1, without transactions: D1 has none that read.

import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import { AUTH_MODELS } from '../better-auth.ts'
import type { D1Db } from './accounts.ts'
import { authAccounts, authSessions, authUsers, authVerifications } from './schema.ts'

export const d1AuthDatabase = (db: D1Db) =>
  drizzleAdapter(db, {
    provider: 'sqlite',
    transaction: false,
    schema: {
      [AUTH_MODELS.user]: authUsers,
      [AUTH_MODELS.session]: authSessions,
      [AUTH_MODELS.account]: authAccounts,
      [AUTH_MODELS.verification]: authVerifications,
    },
  })
