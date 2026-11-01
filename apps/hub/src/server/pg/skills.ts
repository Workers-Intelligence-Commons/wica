// Skills on Postgres.

import { and, asc, eq, inArray, ne, or } from 'drizzle-orm'

import type { SkillRecord, Skills } from '../data.ts'
import { uuidv7 } from '../ids.ts'
import { type Db, isUuid } from './db.ts'
import { memberships, skills } from './schema.ts'

const record = {
  id: skills.id,
  ownerId: skills.ownerId,
  organizationId: skills.organizationId,
  visibility: skills.visibility,
  name: skills.name,
  description: skills.description,
  body: skills.body,
}

export const pgSkills = (db: Db): Skills => ({
  visible: (userId) =>
    db
      .select(record)
      .from(skills)
      .where(
        or(
          and(eq(skills.visibility, 'private'), eq(skills.ownerId, userId)),
          and(
            eq(skills.visibility, 'organization'),
            inArray(
              skills.organizationId,
              db
                .select({ id: memberships.organizationId })
                .from(memberships)
                .where(eq(memberships.userId, userId)),
            ),
          ),
          eq(skills.visibility, 'instance'),
        ),
      )
      .orderBy(asc(skills.id)),

  async get(id) {
    if (!isUuid(id)) return null
    const [row] = await db.select(record).from(skills).where(eq(skills.id, id))
    return row ?? null
  },

  async create(input) {
    const [row] = await db
      .insert(skills)
      .values({ id: uuidv7(), ...input })
      .onConflictDoNothing()
      .returning(record)
    return (row as SkillRecord | undefined) ?? 'name_taken'
  },

  async update(id, text) {
    const [current] = await db.select(record).from(skills).where(eq(skills.id, id))
    if (!current) throw new Error(`skill ${id} not found`)
    // A name is unique among the skills of the same visibility and owner (or organization).
    const sameScope =
      current.visibility === 'private'
        ? and(eq(skills.visibility, 'private'), eq(skills.ownerId, current.ownerId))
        : current.visibility === 'organization'
          ? and(
              eq(skills.visibility, 'organization'),
              eq(skills.organizationId, current.organizationId ?? ''),
            )
          : eq(skills.visibility, 'instance')
    const [other] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(and(sameScope, eq(skills.name, text.name), ne(skills.id, id)))
    if (other) return 'name_taken'
    const [row] = await db.update(skills).set(text).where(eq(skills.id, id)).returning(record)
    if (!row) throw new Error(`skill ${id} not found`)
    return row as SkillRecord
  },

  async delete(id) {
    if (!isUuid(id)) return
    await db.delete(skills).where(eq(skills.id, id))
  },
})
