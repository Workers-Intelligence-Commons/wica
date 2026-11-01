// Tables of the `chat` database on Postgres (Compose). Postgres is the source of truth; Electric
// reads only the published tables, and only the columns the application proxy asks it for. The
// grants and the publication for Electric are in a hand-written migration.

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

const at = (name: string) => timestamp(name, { withTimezone: true })
const createdAt = () => at('created_at').notNull().defaultNow()

/** Identity as the application sees it: internal accounts, external identities, organizations. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  /** Roles on the instance: `admin` reaches the administration. */
  roles: text('roles')
    .array()
    .notNull()
    .default(sql`'{}'`),
  createdAt: createdAt(),
})

export const identities = pgTable(
  'identities',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] })],
)

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const memberships = pgTable(
  'memberships',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
)

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    keyHash: text('key_hash').notNull().unique(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAt(),
    revokedAt: at('revoked_at'),
  },
  (t) => [check('api_keys_one_owner', sql`(${t.userId} IS NULL) <> (${t.organizationId} IS NULL)`)],
)

/** Intended for enterprise SSO. */
export const verifiedDomains = pgTable('verified_domains', {
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  domain: text('domain').primaryKey(),
  verifiedAt: at('verified_at'),
})

/**
 * A discussion. `owner_id` is null only for a conversation created by the Store itself; the
 * application always creates its own with their owner.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    parentConversationId: text('parent_conversation_id').references(
      (): AnyPgColumn => conversations.id,
      { onDelete: 'cascade' },
    ),
    parentCallId: text('parent_call_id'),
    title: text('title').notNull().default(''),
    model: text('model'),
    headItemId: text('head_item_id'),
    idSalt: text('id_salt').notNull(),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [index('conversations_owner').on(t.ownerId, t.updatedAt.desc())],
)

/**
 * Write state of a conversation, never synchronized: each write extends the lease, and keeping it
 * on `conversations` would send an update to every client for every batch of tokens.
 */
export const conversationWriters = pgTable('conversation_writers', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  lastSeq: integer('last_seq').notNull().default(0),
  writerEpoch: integer('writer_epoch').notNull().default(0),
  leaseUntil: at('lease_until'),
  leaseMs: integer('lease_ms'),
  interruptRequestedAt: at('interrupt_requested_at'),
})

export const items = pgTable(
  'items',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    parentId: text('parent_id'),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['streaming', 'done', 'interrupted', 'failed'] }).notNull(),
    /** Large tool result: the full content is in `blobs`, `payload` keeps only a preview of it. */
    blobSha256: text('blob_sha256'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.id] }),
    unique().on(t.conversationId, t.seq),
    check('items_status', sql`${t.status} IN ('streaming', 'done', 'interrupted', 'failed')`),
  ],
)

export const itemChunks = pgTable(
  'item_chunks',
  {
    conversationId: text('conversation_id').notNull(),
    itemId: text('item_id').notNull(),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.itemId, t.idx] }),
    foreignKey({
      columns: [t.conversationId, t.itemId],
      foreignColumns: [items.conversationId, items.id],
    }).onDelete('cascade'),
  ],
)

export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  data: jsonb('data').notNull(),
  createdAt: createdAt(),
})

export const snapshots = pgTable('snapshots', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull(),
})

export const toolClaims = pgTable(
  'tool_claims',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    epoch: integer('epoch').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.callId] })],
)

/** Commands received, with their acknowledgement: a replay of the same id gets the same answer. */
export const commands = pgTable('commands', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: createdAt(),
  ackedAt: at('acked_at'),
  ack: jsonb('ack'),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  toolsHash: text('tools_hash'),
  state: jsonb('state').notNull(),
  createdAt: createdAt(),
  expiresAt: at('expires_at').notNull(),
  lastSeenAt: at('last_seen_at').notNull().defaultNow(),
})

/** Last `clientSeq` processed per client and per conversation. */
export const sessionCommands = pgTable(
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
 * Model tokens connected by people, encrypted by the instance key. No shape, no rights for
 * `electric`, never in `items`.
 */
export const modelCredentials = pgTable(
  'model_credentials',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind', { enum: ['api_key', 'oauth'] }).notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyId: text('key_id').notNull(),
    refreshingUntil: bigint('refreshing_until', { mode: 'number' }),
    createdAt: createdAt(),
    revokedAt: at('revoked_at'),
    warnedAt: at('warned_at'),
  },
  (t) => [
    check('model_credentials_kind', sql`${t.kind} IN ('api_key', 'oauth')`),
    uniqueIndex('model_credentials_current')
      .on(t.userId, t.provider)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
)

/**
 * Subscription logins in progress: the question asked by the provider and the person's answer,
 * which arrives through another request.
 */
export const credentialLogins = pgTable('credential_logins', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  prompt: jsonb('prompt'),
  answer: text('answer'),
  createdAt: createdAt(),
})

/**
 * Wake-ups of the Compose scheduler, read with `FOR UPDATE SKIP LOCKED`. `rearm_at` keeps the
 * requested wake-up while a turn holds the row.
 */
export const wakeups = pgTable('wakeups', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  dueAt: at('due_at').notNull(),
  claimedUntil: at('claimed_until'),
  rearmAt: at('rearm_at'),
})

/**
 * Accounts of the `accounts` sign-in mode, kept by Better Auth: its user, its sessions, its
 * credentials and its verification codes. A Better Auth user reaches the hub's `users` through an
 * `identities` row (provider `better-auth`). The property names are the ones Better Auth reads.
 */
export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: at('updated_at').notNull().defaultNow(),
})

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: at('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (t) => [index('auth_sessions_user').on(t.userId)],
)

export const authAccounts = pgTable(
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
    accessTokenExpiresAt: at('access_token_expires_at'),
    refreshTokenExpiresAt: at('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_accounts_user').on(t.userId)],
)

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_verifications_identifier').on(t.identifier)],
)

/** Tool servers that an admin offers to every account. */
export const mcpCatalog = pgTable('mcp_catalog', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull().unique(),
  url: text('url').notNull(),
  description: text('description').notNull().default(''),
  createdAt: createdAt(),
})

/**
 * Tool servers that an account uses, from the catalog or its own. The secret (a fixed token, or
 * the state of the OAuth sign-in) is encrypted by the instance key; its refresh takes the lease
 * `refreshing_until`, in milliseconds, which works the same on D1.
 */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    catalogId: uuid('catalog_id').references(() => mcpCatalog.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    auth: text('auth', { enum: ['none', 'token', 'oauth'] }).notNull(),
    status: text('status', { enum: ['connected', 'sign_in'] }).notNull(),
    ciphertext: text('ciphertext'),
    keyId: text('key_id'),
    refreshingUntil: bigint('refreshing_until', { mode: 'number' }),
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
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
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
