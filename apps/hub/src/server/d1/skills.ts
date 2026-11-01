// Skills on D1.

import { and, asc, eq, inArray, or } from 'drizzle-orm'

import type { SkillRecord, Skills } from '../data.ts'
import { uuidv7 } from '../ids.ts'
import type { D1Db } from './accounts.ts'
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

export const d1Skills = (db: D1Db): Skills => ({
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

  async delete(id) {
    await db.delete(skills).where(eq(skills.id, id))
  },
})
