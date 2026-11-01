// Data contracts of the hub server: the routes and the turns reach storage only through these,
// and each platform provides their implementations (Postgres on Compose; D1 and the conversation
// Durable Objects on Workers).

import type { Credential as PiCredential } from '@earendil-works/pi-ai'
import type { Envelope } from '@wica/protocol'

import type { ChunkRow, ConversationRow, ItemShapeRow, ModelCallRow } from '../shared/rows.ts'
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
  /**
   * Creates an API key, named by its owner (empty: no name); the token is returned only here,
   * storage keeps only its hash.
   */
  createApiKey(
    owner: { userId: string } | { organizationId: string },
    scopes: string[],
    name?: string,
  ): Promise<string>
  /** Keys of the account that are not revoked, oldest first; never their token. */
  apiKeys(userId: string): Promise<{ id: string; name: string; createdAt: string }[]>
  /** Renames a key of the account; false when the account has no such key. */
  renameApiKey(userId: string, id: string, name: string): Promise<boolean>
  /** Revokes a key of the account; false when the account has no such key. */
  revokeApiKey(userId: string, id: string): Promise<boolean>
  /** Display name of the account; `null` when it does not exist. */
  displayName(userId: string): Promise<string | null>
  rename(userId: string, name: string): Promise<void>
  /**
   * Deletes the account with everything that belongs to it in this storage: identities,
   * memberships, keys, model tokens, tool servers and skills. Conversations still owned go with
   * it; the caller first erases or hands over each one.
   */
  deleteAccount(userId: string): Promise<void>
  /** Whether the account gives its conversations to the commons from now on. */
  contributor(userId: string): Promise<boolean>
  setContributor(userId: string, on: boolean): Promise<void>
  /** The account's answer to each kind of consent it has answered. */
  consents(userId: string): Promise<{ kind: string; granted: boolean; at: string }[]>
  setConsent(userId: string, kind: string, granted: boolean): Promise<void>
}

/** Guest keys, and the messages guests send per day under each key that limits them. */
export interface Guests {
  /** Creates a key whose secret has this hash; returns its identifier. */
  create(secretHash: string): Promise<string>
  /** The key exists and its secret has this hash. */
  verify(id: string, secretHash: string): Promise<boolean>
  delete(id: string): Promise<void>
  /**
   * Counts one message under each key for `day` (UTC, `YYYY-MM-DD`), unless one of them already
   * holds `limit`: nothing is counted then, and the answer is false.
   */
  count(keys: string[], day: string, limit: number): Promise<boolean>
  /**
   * Deletes the keys created before `before` (ISO time) that no conversation uses any more, and
   * the counts of the days before `beforeDay`.
   */
  prune(before: string, beforeDay: string): Promise<void>
}

export type ConversationEntry = {
  id: string
  ownerId: string | null
  model: string | null
  /** Salt of the item identifiers. */
  salt: string
  /** In the trash: read-only until restored, erased after `TRASH_MS`. */
  trashed: boolean
  /** Given to the commons under CC0. */
  contributed: boolean
  /** The guest key that owns it while no account does. */
  guestId: string | null
}

/** Who a conversation belongs to: an account, or a guest key while it has none. */
export type Owner = { kind: 'user'; id: string } | { kind: 'guest'; id: string }

/** The account behind a harness identity's `userId`; `null` for a guest (`guest:<key>`). */
export const accountOf = (userId: string | undefined) =>
  userId && !userId.startsWith('guest:') ? userId : null

/** How long a conversation stays in the trash before it is erased. */
export const TRASH_MS = 30 * 24 * 60 * 60_000

/** The list of conversations: who owns each one, its title and its model. */
export interface ConversationIndex {
  /**
   * Creates a conversation with its identifier salt. `txid` identifies the write for a sync
   * that confirms by transaction.
   */
  create(input: {
    owner: Owner
    title: string
    model: string | null
  }): Promise<{ id: string; salt: string; txid?: number }>
  get(conversationId: string): Promise<ConversationEntry | null>
  /** Sets the title only while it is empty. */
  setTitleIfEmpty(conversationId: string, title: string): Promise<void>
  setTitle(conversationId: string, title: string): Promise<void>
  /** Puts the conversation in the trash, from now. */
  trash(conversationId: string): Promise<void>
  /** Takes the conversation out of the trash. */
  restore(conversationId: string): Promise<void>
  /**
   * Leaves the conversation to the commons: it no longer has an owner, and so leaves the owner's
   * list and their export, while its journal stays.
   */
  giveToCommons(conversationId: string): Promise<void>
  /** Conversations put in the trash before `before` (ISO time). */
  trashedBefore(before: string): Promise<string[]>
  /** Sets the model of the next turns (`null`: the default model). */
  setModel(conversationId: string, model: string | null): Promise<void>
  /** Marks the conversation as given to the commons, once: a later call keeps the first time. */
  markContributed(conversationId: string): Promise<void>
  /** Conversations of an account or a guest, the trash included, most recently changed first. */
  list(owner: Owner): Promise<ConversationRow[]>
  /** Conversations of guests that no one has changed since `before` (ISO time). */
  guestsIdleSince(before: string): Promise<string[]>
  /** Hands every conversation of the guest to an account, or to another guest key. */
  claim(guestId: string, to: Owner): Promise<void>
  delete(conversationId: string): Promise<void>
}

/** The completed model calls of the conversations, written by the turns. */
export interface ModelCalls {
  record(call: ModelCallRow): Promise<void>
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
  read(conversationId: string): Promise<{
    head: string | null
    items: ItemShapeRow[]
    chunks: ChunkRow[]
    calls: ModelCallRow[]
  }>
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
  /** False when the connection is not the account's; `name_taken` as for `connect`. */
  rename(userId: string, id: string, name: string): Promise<boolean | 'name_taken'>
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
  /** Replaces the text of a skill; `name_taken` as for `create`. */
  update(
    id: string,
    text: Pick<SkillRecord, 'name' | 'description' | 'body'>,
  ): Promise<SkillRecord | 'name_taken'>
  delete(id: string): Promise<void>
}
