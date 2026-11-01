// Skills of the accounts, kept in the database: who may publish and remove which skill, the
// skills of one turn (the `load_skill` tool of `@wica/skills`, reading the database), and the
// `create_skill` tool, which saves a private skill once the person has approved it.

import type { Tool } from '@wica/runtime'
import { parseSkill, SkillFormatError, skillsKit } from '@wica/skills'

import { ADMIN_ROLE, type SkillRecord, type Skills, type SkillVisibility } from './data.ts'
import type { Principal } from './identity.ts'

export const CREATE_SKILL_TOOL = 'create_skill'
export const SKILL_BODY_MAX = 100_000

type SkillText = Pick<SkillRecord, 'name' | 'description' | 'body'>

/** The skill as its `SKILL.md`; a JSON string is a valid YAML scalar. */
export const skillMarkdown = (skill: SkillText) =>
  `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`

const location = (skill: Pick<SkillRecord, 'id' | 'name'>) => `skills/${skill.id}/${skill.name}`

/** Why the skill is refused, by the rules of the Agent Skills format; `null` when it is valid. */
export function skillProblem(skill: SkillText): string | null {
  if (!skill.body.trim()) return 'the instructions are empty'
  if (skill.body.length > SKILL_BODY_MAX) {
    return `the instructions are longer than ${SKILL_BODY_MAX} characters`
  }
  const place = location({ id: 'new', name: skill.name })
  try {
    parseSkill(skillMarkdown(skill), place)
  } catch (error) {
    if (!(error instanceof SkillFormatError)) throw error
    return error.message.slice(place.length).replace(/^\s*:\s*/, '')
  }
  return null
}

/** Private: any account; organization: its members; instance: the admins. */
export function mayPublish(
  principal: Principal,
  visibility: SkillVisibility,
  organizationId: string | null,
) {
  if (visibility === 'private') return organizationId === null
  if (visibility === 'organization') return principal.orgs.some((o) => o.id === organizationId)
  return organizationId === null && principal.scopes.includes(ADMIN_ROLE)
}

/** The creator of a skill removes it, and so does an admin. */
export const mayRemove = (principal: Principal, skill: SkillRecord) =>
  skill.ownerId === principal.id || principal.scopes.includes(ADMIN_ROLE)

const RANK: Record<SkillVisibility, number> = { private: 0, organization: 1, instance: 2 }

/**
 * Skills of a turn: for each name, the skill closest to the person (private, then organization,
 * then instance; the oldest among equals), so that each name the model sees is one skill.
 */
export function turnSkills(records: SkillRecord[]) {
  const chosen = new Map<string, SkillRecord>()
  for (const skill of records.toSorted((a, b) => RANK[a.visibility] - RANK[b.visibility])) {
    if (!chosen.has(skill.name)) chosen.set(skill.name, skill)
  }
  const files = new Map([...chosen.values()].map((s) => [`${location(s)}/SKILL.md`, s]))
  return skillsKit(
    [...chosen.values()].map((s) => ({
      name: s.name,
      description: s.description,
      location: location(s),
    })),
    async (path) => {
      const skill = files.get(path)
      // A skill of the database is its `SKILL.md` alone.
      if (!skill) throw new SkillFormatError(`this skill has no file ${path}`)
      return skillMarkdown(skill)
    },
  )
}

type CreateSkillInput = { name?: unknown; description?: unknown; instructions?: unknown }

/** Question of the approval: the person sees the whole skill before it is saved. */
export function createSkillQuestion(input: unknown) {
  const { name, description, instructions } = (input ?? {}) as CreateSkillInput
  return `Save the skill "${String(name)}" in your private skills?\n\n${String(description)}\n\n${String(instructions)}`
}

/** Saves a private skill of `ownerId`; the host makes each call wait for the person's approval. */
export function createSkillTool(skills: Skills, ownerId: string): Tool {
  return {
    spec: {
      name: CREATE_SKILL_TOOL,
      description:
        "Saves a new skill in the person's private skills, once they approve it. A skill is a " +
        'name, a description of when to use it, and instructions in Markdown; it can be loaded ' +
        'from the next turn on.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '1 to 64 lowercase letters, digits and single hyphens.',
          },
          description: {
            type: 'string',
            description: 'What the skill does and when to use it, up to 1024 characters.',
          },
          instructions: { type: 'string', description: 'The instructions, in Markdown.' },
        },
        required: ['name', 'description', 'instructions'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      channel: 'environment',
      runsOn: 'server',
    },
    run: async (input) => {
      const { name, description, instructions } = (input ?? {}) as CreateSkillInput
      if (
        typeof name !== 'string' ||
        typeof description !== 'string' ||
        typeof instructions !== 'string'
      ) {
        throw new Error('name, description and instructions must be texts')
      }
      const skill = { name, description: description.trim(), body: instructions.trim() }
      const problem = skillProblem(skill)
      if (problem) throw new Error(`the skill was not saved: ${problem}`)
      const saved = await skills.create({
        ...skill,
        ownerId,
        organizationId: null,
        visibility: 'private',
      })
      if (saved === 'name_taken') throw new Error(`a private skill named ${name} already exists`)
      return [{ type: 'text', text: `The skill ${name} is saved in the private skills.` }]
    },
  }
}
