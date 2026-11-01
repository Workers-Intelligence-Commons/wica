// Accounts, identities, organizations and API keys on Postgres.

import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'

import { randomToken, sha256Hex } from '../crypto.ts'
import { ADMIN_ROLE, type Accounts } from '../data.ts'
import { uuidv7 } from '../ids.ts'
import { API_KEY_PREFIX, type ExternalProfile, type Principal } from '../identity.ts'
import { type Db, isUuid } from './db.ts'
import { apiKeys, consents, identities, memberships, organizations, users } from './schema.ts'

export class PgAccounts implements Accounts {
  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async principal(userId: string): Promise<Principal | null> {
    const [user] = await this.#db
      .select({ id: users.id, roles: users.roles })
      .from(users)
      .where(eq(users.id, userId))
    if (!user) return null
    const orgs = await this.#db
      .select({ id: memberships.organizationId, roles: memberships.roles })
      .from(memberships)
      .where(eq(memberships.userId, userId))
    const admin = user.roles.includes(ADMIN_ROLE) ? [ADMIN_ROLE] : []
    return { id: user.id, kind: 'user', orgs, scopes: ['chat', ...admin] }
  }

  async list() {
    const rows = await this.#db
      .select({ id: users.id, name: users.displayName, roles: users.roles })
      .from(users)
      .orderBy(asc(users.createdAt))
    return rows.map((r) => ({ id: r.id, name: r.name, admin: r.roles.includes(ADMIN_ROLE) }))
  }

  async setAdmin(userId: string, granted: boolean) {
    const without = sql`array_remove(${users.roles}, ${ADMIN_ROLE})`
    const updated = await this.#db
      .update(users)
      .set({ roles: granted ? sql`array_append(${without}, ${ADMIN_ROLE})` : without })
      .where(eq(users.id, userId))
      .returning({ id: users.id })
    return updated.length > 0
  }

  organizations(userId: string) {
    return this.#db
      .select({ id: organizations.id, name: organizations.name })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(organizations.name))
  }

  async subject(userId: string, provider: string) {
    const [row] = await this.#db
      .select({ subject: identities.subject })
      .from(identities)
      .where(and(eq(identities.userId, userId), eq(identities.provider, provider)))
    return row?.subject ?? null
  }

  async apiKey(hash: string): Promise<Principal | null> {
    const [key] = await this.#db
      .select({
        userId: apiKeys.userId,
        organizationId: apiKeys.organizationId,
        scopes: apiKeys.scopes,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    if (!key) return null
    if (key.userId) {
      const user = await this.principal(key.userId)
      return user && { ...user, kind: 'apiKey', scopes: key.scopes }
    }
    const organizationId = key.organizationId as string
    return {
      id: organizationId,
      kind: 'apiKey',
      orgs: [{ id: organizationId, roles: [] }],
      scopes: key.scopes,
    }
  }

  async link(profile: ExternalProfile): Promise<string> {
    return this.#db.transaction(async (tx) => {
      const [known] = await tx
        .select({ userId: identities.userId })
        .from(identities)
        .where(
          and(eq(identities.provider, profile.provider), eq(identities.subject, profile.subject)),
        )
      let userId = known?.userId
      if (!userId) {
        userId = uuidv7()
        await tx.insert(users).values({ id: userId, displayName: profile.name })
        await tx
          .insert(identities)
          .values({ provider: profile.provider, subject: profile.subject, userId })
      }
      if (profile.orgs) {
        const kept: string[] = []
        for (const org of profile.orgs) {
          const [existing] = await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.name, org.name))
            .orderBy(asc(organizations.createdAt))
            .limit(1)
          const orgId = existing?.id ?? uuidv7()
          if (!existing) await tx.insert(organizations).values({ id: orgId, name: org.name })
          await tx
            .insert(memberships)
            .values({ organizationId: orgId, userId, roles: org.roles })
            .onConflictDoUpdate({
              target: [memberships.organizationId, memberships.userId],
              set: { roles: org.roles },
            })
          kept.push(orgId)
        }
        await tx
          .delete(memberships)
          .where(and(eq(memberships.userId, userId), notInArray(memberships.organizationId, kept)))
      }
      return userId
    })
  }

  async createApiKey(
    owner: { userId: string } | { organizationId: string },
    scopes: string[],
    name = '',
  ) {
    const token = randomToken(API_KEY_PREFIX)
    await this.#db.insert(apiKeys).values({
      id: uuidv7(),
      keyHash: await sha256Hex(token),
      userId: 'userId' in owner ? owner.userId : null,
      organizationId: 'organizationId' in owner ? owner.organizationId : null,
      scopes,
      name,
    })
    return token
  }

  async apiKeys(userId: string) {
    const rows = await this.#db
      .select({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .orderBy(asc(apiKeys.createdAt))
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString() }))
  }

  async renameApiKey(userId: string, id: string, name: string) {
    if (!isUuid(id)) return false
    const renamed = await this.#db
      .update(apiKeys)
      .set({ name })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id })
    return renamed.length > 0
  }

  async revokeApiKey(userId: string, id: string) {
    if (!isUuid(id)) return false
    const revoked = await this.#db
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id })
    return revoked.length > 0
  }

  async displayName(userId: string) {
    const [user] = await this.#db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
    return user?.name ?? null
  }

  async rename(userId: string, name: string) {
    await this.#db.update(users).set({ displayName: name }).where(eq(users.id, userId))
  }

  async deleteAccount(userId: string) {
    // Every row of the account refers to `users` with a cascade.
    await this.#db.delete(users).where(eq(users.id, userId))
  }

  async contributor(userId: string) {
    const [user] = await this.#db
      .select({ on: users.contributor })
      .from(users)
      .where(eq(users.id, userId))
    return user?.on ?? false
  }

  async setContributor(userId: string, on: boolean) {
    await this.#db.update(users).set({ contributor: on }).where(eq(users.id, userId))
  }

  async consents(userId: string) {
    const rows = await this.#db
      .select({ kind: consents.kind, granted: consents.granted, at: consents.at })
      .from(consents)
      .where(eq(consents.userId, userId))
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }))
  }

  async setConsent(userId: string, kind: string, granted: boolean) {
    await this.#db
      .insert(consents)
      .values({ userId, kind, granted })
      .onConflictDoUpdate({
        target: [consents.userId, consents.kind],
        set: { granted, at: sql`now()` },
      })
  }
}
