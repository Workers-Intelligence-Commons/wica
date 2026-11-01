// Accounts, identities, organizations and API keys on D1.

import { and, asc, eq, isNull, notInArray } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import { randomToken, sha256Hex } from '../crypto.ts'
import { ADMIN_ROLE, type Accounts } from '../data.ts'
import { uuidv7 } from '../ids.ts'
import { API_KEY_PREFIX, type ExternalProfile, type Principal } from '../identity.ts'
import { apiKeys, identities, memberships, organizations, users } from './schema.ts'

export type D1Db = DrizzleD1Database

const nowIso = () => new Date().toISOString()

export class D1Accounts implements Accounts {
  readonly #db: D1Db

  constructor(db: D1Db) {
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
    const [user] = await this.#db
      .select({ roles: users.roles })
      .from(users)
      .where(eq(users.id, userId))
    if (!user) return false
    const roles = user.roles.filter((r) => r !== ADMIN_ROLE)
    await this.#db
      .update(users)
      .set({ roles: granted ? [...roles, ADMIN_ROLE] : roles })
      .where(eq(users.id, userId))
    return true
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

  async #linked(profile: ExternalProfile) {
    const [row] = await this.#db
      .select({ userId: identities.userId })
      .from(identities)
      .where(
        and(eq(identities.provider, profile.provider), eq(identities.subject, profile.subject)),
      )
    return row?.userId
  }

  async link(profile: ExternalProfile): Promise<string> {
    let userId = await this.#linked(profile)
    if (!userId) {
      // D1 has no transaction that reads: two first sign-ins of the same identity each write an
      // account, the identity keeps one, and the other account is deleted.
      const created = uuidv7()
      await this.#db.batch([
        this.#db.insert(users).values({ id: created, displayName: profile.name }),
        this.#db
          .insert(identities)
          .values({ provider: profile.provider, subject: profile.subject, userId: created })
          .onConflictDoNothing(),
      ])
      userId = await this.#linked(profile)
      if (userId !== created) await this.#db.delete(users).where(eq(users.id, created))
      if (!userId) throw new Error(`identity not recorded: ${profile.provider}`)
    }
    if (profile.orgs) {
      const kept: string[] = []
      for (const org of profile.orgs) {
        const [existing] = await this.#db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.name, org.name))
          .orderBy(asc(organizations.createdAt))
          .limit(1)
        const orgId = existing?.id ?? uuidv7()
        if (!existing) await this.#db.insert(organizations).values({ id: orgId, name: org.name })
        await this.#db
          .insert(memberships)
          .values({ organizationId: orgId, userId, roles: org.roles })
          .onConflictDoUpdate({
            target: [memberships.organizationId, memberships.userId],
            set: { roles: org.roles },
          })
        kept.push(orgId)
      }
      await this.#db
        .delete(memberships)
        .where(and(eq(memberships.userId, userId), notInArray(memberships.organizationId, kept)))
    }
    return userId
  }

  async createApiKey(owner: { userId: string } | { organizationId: string }, scopes: string[]) {
    const token = randomToken(API_KEY_PREFIX)
    await this.#db.insert(apiKeys).values({
      id: uuidv7(),
      keyHash: await sha256Hex(token),
      userId: 'userId' in owner ? owner.userId : null,
      organizationId: 'organizationId' in owner ? owner.organizationId : null,
      scopes,
    })
    return token
  }

  async apiKeys(userId: string) {
    const rows = await this.#db
      .select({ id: apiKeys.id, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .orderBy(asc(apiKeys.createdAt))
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt }))
  }

  async revokeApiKey(userId: string, id: string) {
    const revoked = await this.#db
      .update(apiKeys)
      .set({ revokedAt: nowIso() })
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
}
