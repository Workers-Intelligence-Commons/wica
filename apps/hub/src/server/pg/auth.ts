// Storage of Better Auth on Postgres.

import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import { AUTH_MODELS } from '../better-auth.ts'
import type { Db } from './db.ts'
import { authAccounts, authSessions, authUsers, authVerifications } from './schema.ts'

export const pgAuthDatabase = (db: Db) =>
  drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      [AUTH_MODELS.user]: authUsers,
      [AUTH_MODELS.session]: authSessions,
      [AUTH_MODELS.account]: authAccounts,
      [AUTH_MODELS.verification]: authVerifications,
    },
  })
