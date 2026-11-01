// Tables of the D1 database on Workers: everything that is not the journal of one conversation.
// The journal lives in the SQLite database of its conversation's Durable Object (`../do/`).
// Times are ISO 8601 text, which sorts like the time; a lease is a number of milliseconds.

import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
const createdAt = () => text('created_at').notNull().default(now)
const list = (name: string) =>
  text(name, { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`)

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  /** Roles on the instance: `admin` reaches the administration. */
  roles: list('roles'),
  /** Gives the conversations to the commons from now on (CC0); off until the person turns it on. */
  contributor: integer('contributor', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
})

export const identities = sqliteTable(
  'identities',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] })],
)

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const memberships = sqliteTable(
  'memberships',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roles: list('roles'),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    keyHash: text('key_hash').notNull().unique(),
    /** Given by its owner to tell their keys apart; empty without one. */
    name: text('name').notNull().default(''),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    scopes: list('scopes'),
    createdAt: createdAt(),
    revokedAt: text('revoked_at'),
  },
  (t) => [check('api_keys_one_owner', sql`(${t.userId} IS NULL) <> (${t.organizationId} IS NULL)`)],
)

/** The list of conversations. `head_item_id` and `updated_at` are copied from the journal after each turn. */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    /** Null for a guest's conversation and for one left to the commons. */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    parentConversationId: text('parent_conversation_id').references(
      (): AnySQLiteColumn => conversations.id,
      { onDelete: 'cascade' },
    ),
    parentCallId: text('parent_call_id'),
    title: text('title').notNull().default(''),
    model: text('model'),
    headItemId: text('head_item_id'),
    idSalt: text('id_salt').notNull(),
    /**
     * When the conversation was given to the commons under CC0: set by the first message sent
     * while its owner contributes, and never cleared, since the dedication cannot be withdrawn.
     */
    contributedAt: text('contributed_at'),
    /** When it was put in the trash; erased `TRASH_MS` later unless restored. */
    deletedAt: text('deleted_at'),
    /**
     * The guest key (`guests`) that started it, while no account owns it; the owner is then
     * null. Moved to the account when the guest signs in.
     */
    guestId: text('guest_id'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('conversations_owner').on(t.ownerId, t.updatedAt),
    index('conversations_guest').on(t.guestId),
  ],
)

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  state: text('state', { mode: 'json' }).notNull(),
  createdAt: createdAt(),
  expiresAt: integer('expires_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull().default(now),
})

/** Last `clientSeq` processed per client and per conversation. */
export const sessionCommands = sqliteTable(
  'session_commands',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    conversationId: text('conversation_id').notNull(),
    clientSeq: integer('client_seq').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.conversationId] })],
)

/**
 * Model tokens connected by people, encrypted by the instance key. D1 has no row lock: a turn
 * that refreshes a token first sets `refreshing_until`, in milliseconds since 1970, by one
 * conditional statement.
 */
export const modelCredentials = sqliteTable(
  'model_credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind', { enum: ['api_key', 'oauth'] }).notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyId: text('key_id').notNull(),
    refreshingUntil: integer('refreshing_until'),
    createdAt: createdAt(),
    revokedAt: text('revoked_at'),
    warnedAt: text('warned_at'),
  },
  (t) => [
    check('model_credentials_kind', sql`${t.kind} IN ('api_key', 'oauth')`),
    uniqueIndex('model_credentials_current')
      .on(t.userId, t.provider)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
)

/** Subscription sign-ins in progress: the provider's question and the person's answer. */
export const credentialLogins = sqliteTable('credential_logins', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  prompt: text('prompt', { mode: 'json' }),
  answer: text('answer'),
  createdAt: createdAt(),
})

const instant = (name: string) => integer(name, { mode: 'timestamp_ms' })
const createdInstant = () =>
  instant('created_at')
    .notNull()
    .$defaultFn(() => new Date())
const updatedInstant = () =>
  instant('updated_at')
    .notNull()
    .$defaultFn(() => new Date())

/**
 * Accounts of the `accounts` sign-in mode, kept by Better Auth: its user, its sessions, its
 * credentials and its verification codes. A Better Auth user reaches the hub's `users` through an
 * `identities` row (provider `better-auth`). The property names are the ones Better Auth reads.
 */
export const authUsers = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: createdInstant(),
  updatedAt: updatedInstant(),
})

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: instant('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdInstant(),
    updatedAt: updatedInstant(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [index('auth_sessions_user').on(t.userId)],
)

export const authAccounts = sqliteTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: instant('access_token_expires_at'),
    refreshTokenExpiresAt: instant('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdInstant(),
    updatedAt: updatedInstant(),
  },
  (t) => [index('auth_accounts_user').on(t.userId)],
)

export const authVerifications = sqliteTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: instant('expires_at').notNull(),
    createdAt: createdInstant(),
    updatedAt: updatedInstant(),
  },
  (t) => [index('auth_verifications_identifier').on(t.identifier)],
)

/** Tool servers that an admin offers to every account. */
export const mcpCatalog = sqliteTable('mcp_catalog', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  description: text('description').notNull().default(''),
  createdAt: createdAt(),
})

/**
 * Tool servers that an account uses, from the catalog or its own. The secret (a fixed token, or
 * the state of the OAuth sign-in) is encrypted by the instance key; its refresh takes the lease
 * `refreshing_until`.
 */
export const mcpConnections = sqliteTable(
  'mcp_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    catalogId: text('catalog_id').references(() => mcpCatalog.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    auth: text('auth', { enum: ['none', 'token', 'oauth'] }).notNull(),
    status: text('status', { enum: ['connected', 'sign_in'] }).notNull(),
    ciphertext: text('ciphertext'),
    keyId: text('key_id'),
    refreshingUntil: integer('refreshing_until'),
    createdAt: createdAt(),
  },
  (t) => [
    check('mcp_connections_auth', sql`${t.auth} IN ('none', 'token', 'oauth')`),
    check('mcp_connections_status', sql`${t.status} IN ('connected', 'sign_in')`),
    uniqueIndex('mcp_connections_name').on(t.userId, t.name),
  ],
)

/**
 * Skills in the Agent Skills format, kept whole in the database. Private: seen by the creator;
 * organization: by its members; instance: by every account, created by admins.
 */
export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    visibility: text('visibility', { enum: ['private', 'organization', 'instance'] }).notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('skills_visibility', sql`${t.visibility} IN ('private', 'organization', 'instance')`),
    check(
      'skills_organization',
      sql`(${t.visibility} = 'organization') = (${t.organizationId} IS NOT NULL)`,
    ),
    uniqueIndex('skills_private_name')
      .on(t.ownerId, t.name)
      .where(sql`${t.visibility} = 'private'`),
    uniqueIndex('skills_organization_name')
      .on(t.organizationId, t.name)
      .where(sql`${t.visibility} = 'organization'`),
    uniqueIndex('skills_instance_name')
      .on(t.name)
      .where(sql`${t.visibility} = 'instance'`),
  ],
)

/**
 * Guest keys: a person without an account keeps the key in their browser and sends it with each
 * request; only the hash of its secret is stored.
 */
export const guests = sqliteTable('guests', {
  id: text('id').primaryKey(),
  secretHash: text('secret_hash').notNull(),
  createdAt: createdAt(),
})

/**
 * Messages sent by guests per UTC day, counted under each key that limits them: the guest key
 * (`g:` and its id) and the fingerprint of the browser and its network (`f:` and its hash).
 */
export const guestUsage = sqliteTable(
  'guest_usage',
  {
    key: text('key').notNull(),
    day: text('day').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.day] })],
)

/** The answer of an account for each kind of consent (`shared/consent.ts`). */
export const consents = sqliteTable(
  'consents',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    granted: integer('granted', { mode: 'boolean' }).notNull(),
    at: text('at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
)
