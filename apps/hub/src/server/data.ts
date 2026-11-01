// Data contracts of the hub server: the routes and the turns reach storage only through these,
// and each platform provides their implementations (Postgres on Compose; D1 and the conversation
// Durable Objects on Workers).

import type { Credential as PiCredential } from '@earendil-works/pi-ai'
import type { Envelope } from '@wica/protocol'

import type { ChunkRow, ConversationRow, ItemShapeRow } from '../shared/rows.ts'
import type { IdentityRepo } from './identity.ts'

export const ADMIN_ROLE = 'admin'

export type AccountSummary = { id: string; name: string; admin: boolean }

/** Internal accounts, external identities, organizations and API keys. */
export interface Accounts extends IdentityRepo {
  /** Every account, oldest first. */
  list(): Promise<AccountSummary[]>
  /** Grants or removes the admin role; false when the account does not exist. */
  setAdmin(userId: string, granted: boolean): Promise<boolean>
  /** Organizations of the account, by name. */
  organizations(userId: string): Promise<{ id: string; name: string }[]>
  /** Subject of the account's identity at `provider`; `null` without one. */
  subject(userId: string, provider: string): Promise<string | null>
  /** Creates an API key; the token is returned only here, storage keeps only its hash. */
  createApiKey(
    owner: { userId: string } | { organizationId: string },
    scopes: string[],
  ): Promise<string>
  /** Keys of the account that are not revoked, oldest first; never their token. */
  apiKeys(userId: string): Promise<{ id: string; createdAt: string }[]>
  /** Revokes a key of the account; false when the account has no such key. */
  revokeApiKey(userId: string, id: string): Promise<boolean>
  /** Display name of the account; `null` when it does not exist. */
  displayName(userId: string): Promise<string | null>
}

export type ConversationEntry = {
  id: string
  ownerId: string | null
  model: string | null
  /** Salt of the item identifiers. */
  salt: string
}

/** The list of conversations: who owns each one, its title and its model. */
export interface ConversationIndex {
  /**
   * Creates a conversation with its identifier salt. `txid` identifies the write for a sync
   * that confirms by transaction.
   */
  create(input: {
    ownerId: string
    title: string
    model: string | null
  }): Promise<{ id: string; salt: string; txid?: number }>
  get(conversationId: string): Promise<ConversationEntry | null>
  /** Sets the title only while it is empty. */
  setTitleIfEmpty(conversationId: string, title: string): Promise<void>
  /** Conversations of an account, most recently changed first. */
  list(ownerId: string): Promise<ConversationRow[]>
  delete(conversationId: string): Promise<void>
}

export type CommandOutcome =
  | { kind: 'acked'; ack: { ok: true } | { ok: false; error: string }; sessionId?: string }
  /** The command identifier is already taken by another conversation. */
  | { kind: 'conflict' }

/** Where the journal of conversations lives and where their turns run. */
export interface ConversationHost {
  /**
   * Runs a command of the owner, already checked by the caller. A replay of the same
   * `commandId` returns the first acknowledgement without running it again.
   */
  command(
    envelope: Envelope,
    from: { userId: string; harnessSession?: string },
  ): Promise<CommandOutcome>
  /** Scheduled wake-up: the next turn of the conversation. */
  wake(conversationId: string): Promise<void>
  /** Rows of the journal for server rendering. */
  read(
    conversationId: string,
  ): Promise<{ head: string | null; items: ItemShapeRow[]; chunks: ChunkRow[] }>
  /** Erases the journal and everything the turns kept for it; the index entry stays. */
  erase(conversationId: string): Promise<void>
}

export type { PiCredential }

/**
 * People's model tokens, one current row per account and provider, sealed by the instance key.
 * Each row carries a refresh lease (`lease.ts`).
 */
export interface ModelTokenRows {
  current(userId: string, provider: string): Promise<SealedSecret | null>
  list(userId: string): Promise<{ providerId: string; type: PiCredential['type'] }[]>
  /**
   * Takes the refresh lease of the current row until `until` when no lease runs at `now`, and
   * returns the row then. `busy` while another lease runs; `missing` when there is no row.
   */
  lease(
    userId: string,
    provider: string,
    until: number,
    now: number,
  ): Promise<{ id: string; secret: SealedSecret } | 'busy' | 'missing'>
  /**
   * Ends the lease taken until `until`, writing `change` when given. A lease that another holder
   * has taken since stays; `change` is written anyway, since the provider may have invalidated
   * the previous token.
   */
  release(
    id: string,
    until: number,
    change?: { secret: SealedSecret; type: PiCredential['type'] },
  ): Promise<void>
  /** False when the account already has a current row for the provider. */
  insert(
    userId: string,
    provider: string,
    type: PiCredential['type'],
    secret: SealedSecret,
  ): Promise<boolean>
  revoke(userId: string, provider: string): Promise<void>
  /** True the first time only. */
  markWarned(userId: string, provider: string): Promise<boolean>
}

/**
 * Subscription sign-ins in progress: the provider's question and the person's answer, which
 * arrives through another request, maybe another process.
 */
export interface SignInPrompts {
  open(userId: string): Promise<string>
  /** Records the question and clears any previous answer. */
  ask(loginId: string, prompt: unknown): Promise<void>
  answer(loginId: string): Promise<string | null>
  /** Gives the answer of the person; false when the sign-in is not theirs or is gone. */
  reply(userId: string, loginId: string, answer: string): Promise<boolean>
  close(loginId: string): Promise<void>
}

export type McpCatalogEntry = { id: string; name: string; url: string; description: string }

/** How the hub signs in to a tool server: nothing, a fixed token, or the MCP OAuth sign-in. */
export type McpAuth = 'none' | 'token' | 'oauth'

/** `sign_in`: the OAuth sign-in has not finished, or the server refused the refreshed token. */
export type McpStatus = 'connected' | 'sign_in'

/** A tool server that an account uses, from the catalog (`catalogId`) or its own. */
export type McpConnection = {
  id: string
  userId: string
  name: string
  url: string
  catalogId: string | null
  auth: McpAuth
  status: McpStatus
}

/** A secret encrypted by the instance key; storage never sees it in clear. */
export type SealedSecret = { ciphertext: string; key_id: string }

/** The tool server catalog of the instance, and the tool servers of each account. */
export interface McpServers {
  catalog(): Promise<McpCatalogEntry[]>
  catalogEntry(id: string): Promise<McpCatalogEntry | null>
  /** `name_taken` when another catalog entry has the name. */
  addToCatalog(entry: Omit<McpCatalogEntry, 'id'>): Promise<McpCatalogEntry | 'name_taken'>
  /** Removes the entry and the connections of every account to it. */
  removeFromCatalog(id: string): Promise<void>
  /** Connections of an account, in the order of their names. */
  connections(userId: string): Promise<McpConnection[]>
  connection(id: string): Promise<(McpConnection & { secret: SealedSecret | null }) | null>
  /** `name_taken` when another connection of the account has the name. */
  connect(
    input: Omit<McpConnection, 'id'> & { secret: SealedSecret | null },
  ): Promise<McpConnection | 'name_taken'>
  /** False when the connection is not the account's. */
  disconnect(userId: string, id: string): Promise<boolean>
  /** Replaces the secret and the status, outside any lease. */
  save(id: string, change: { secret: SealedSecret | null; status: McpStatus }): Promise<void>
  /**
   * Takes the refresh lease of the connection until `until` when no lease is running at `now`,
   * and returns its secret then. `busy` while another lease runs; `missing` when the connection
   * is gone.
   */
  lease(
    id: string,
    until: number,
    now: number,
  ): Promise<{ secret: SealedSecret | null } | 'busy' | 'missing'>
  /**
   * Ends the lease taken until `until`, writing `change` when given. A lease that another holder
   * has taken since stays. A new secret is written anyway, since the server may have invalidated
   * the previous token; `sign_in` only while the lease is still this one, since the holder that
   * took over decides then.
   */
  release(
    id: string,
    until: number,
    change?: { secret: SealedSecret | null; status: 'connected' } | { status: 'sign_in' },
  ): Promise<void>
}

/** Private: seen by the creator; organization: by its members; instance: by every account. */
export type SkillVisibility = 'private' | 'organization' | 'instance'

export type SkillRecord = {
  id: string
  ownerId: string
  /** Set exactly when the visibility is `organization`. */
  organizationId: string | null
  visibility: SkillVisibility
  name: string
  description: string
  /** Instructions: the body of its `SKILL.md`. */
  body: string
}

/** Skills kept in the database. */
export interface Skills {
  /** Skills that the account sees, oldest first. */
  visible(userId: string): Promise<SkillRecord[]>
  get(id: string): Promise<SkillRecord | null>
  /** `name_taken` when another skill of the same visibility and owner has the name. */
  create(input: Omit<SkillRecord, 'id'>): Promise<SkillRecord | 'name_taken'>
  delete(id: string): Promise<void>
}
