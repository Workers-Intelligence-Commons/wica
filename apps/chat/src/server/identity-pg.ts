// Accounts, identities, organizations, API keys and remote servers in the `chat` database.

import type postgres from 'postgres'

import { randomToken, sha256Hex } from './crypto.ts'
import {
  API_KEY_PREFIX,
  type ExternalProfile,
  type IdentityRepo,
  type Principal,
} from './identity.ts'

/** Internal identifiers sorted by date (UUID v7). */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const time = BigInt(now)
  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn)
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export class PgIdentityRepo implements IdentityRepo {
  readonly #sql: postgres.Sql

  constructor(sql: postgres.Sql) {
    this.#sql = sql
  }

  async principal(userId: string): Promise<Principal | null> {
    const [user] = await this.#sql<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId}`
    if (!user) return null
    const orgs = await this.#sql<{ organization_id: string; roles: string[] }[]>`
      SELECT organization_id, roles FROM memberships WHERE user_id = ${userId}`
    return {
      id: user.id,
      kind: 'user',
      orgs: orgs.map((o) => ({ id: o.organization_id, roles: o.roles })),
      scopes: ['chat'],
    }
  }

  async apiKey(hash: string): Promise<Principal | null> {
    const [key] = await this.#sql<
      { user_id: string | null; organization_id: string | null; scopes: string[] }[]
    >`
      SELECT user_id, organization_id, scopes FROM api_keys
      WHERE key_hash = ${hash} AND revoked_at IS NULL`
    if (!key) return null
    if (key.user_id) {
      const user = await this.principal(key.user_id)
      return user && { ...user, kind: 'apiKey', scopes: key.scopes }
    }
    return {
      id: key.organization_id as string,
      kind: 'apiKey',
      orgs: [{ id: key.organization_id as string, roles: [] }],
      scopes: key.scopes,
    }
  }

  async link(profile: ExternalProfile): Promise<string> {
    return this.#sql.begin(async (sql) => {
      const [known] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM identities
        WHERE provider = ${profile.provider} AND subject = ${profile.subject}`
      let userId = known?.user_id
      if (!userId) {
        userId = uuidv7()
        await sql`INSERT INTO users (id, display_name) VALUES (${userId}, ${profile.name})`
        await sql`
          INSERT INTO identities (provider, subject, user_id)
          VALUES (${profile.provider}, ${profile.subject}, ${userId})`
      }
      if (profile.orgs) {
        const kept: string[] = []
        for (const org of profile.orgs) {
          const [existing] = await sql<{ id: string }[]>`
            SELECT id FROM organizations WHERE name = ${org.name} ORDER BY created_at LIMIT 1`
          const orgId = existing?.id ?? uuidv7()
          if (!existing)
            await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, ${org.name})`
          await sql`
            INSERT INTO memberships (organization_id, user_id, roles)
            VALUES (${orgId}, ${userId}, ${org.roles})
            ON CONFLICT (organization_id, user_id) DO UPDATE SET roles = EXCLUDED.roles`
          kept.push(orgId)
        }
        await sql`
          DELETE FROM memberships
          WHERE user_id = ${userId} AND NOT (organization_id = ANY(${kept}::uuid[]))`
      }
      return userId
    })
  }

  async createUser(name: string): Promise<string> {
    const id = uuidv7()
    await this.#sql`INSERT INTO users (id, display_name) VALUES (${id}, ${name})`
    return id
  }

  /** Creates an API key; the token is returned only here, the database keeps only its hash. */
  async createApiKey(owner: { userId: string } | { organizationId: string }, scopes: string[]) {
    const token = randomToken(API_KEY_PREFIX)
    await this.#sql`
      INSERT INTO api_keys (id, key_hash, user_id, organization_id, scopes)
      VALUES (${uuidv7()}, ${await sha256Hex(token)},
              ${'userId' in owner ? owner.userId : null},
              ${'organizationId' in owner ? owner.organizationId : null}, ${scopes})`
    return token
  }

  async revokeApiKey(id: string) {
    await this.#sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`
  }
}

export type ServerIdentity = { serverId: string; ownerId: string }

export const SERVER_TOKEN_PREFIX = 'wicasrv'

/** Remote server recognized by its token, if it is not revoked. */
export async function serverByToken(
  sql: postgres.Sql,
  token: string,
): Promise<ServerIdentity | null> {
  if (!token.startsWith(`${SERVER_TOKEN_PREFIX}_`)) return null
  const [row] = await sql<{ id: string; owner_id: string }[]>`
    SELECT id, owner_id FROM servers WHERE token_hash = ${await sha256Hex(token)} AND revoked_at IS NULL`
  return row ? { serverId: row.id, ownerId: row.owner_id } : null
}

export async function createServer(sql: postgres.Sql, ownerId: string, name: string) {
  const token = randomToken(SERVER_TOKEN_PREFIX)
  const id = uuidv7()
  await sql`
    INSERT INTO servers (id, owner_id, name, token_hash)
    VALUES (${id}, ${ownerId}, ${name}, ${await sha256Hex(token)})`
  return { id, token }
}
