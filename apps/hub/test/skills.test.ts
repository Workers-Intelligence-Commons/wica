import { createHarness } from '@wica/runtime'
import { scriptedModel } from '@wica/testing'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vite-plus/test'

import { d1Skills } from '../src/server/d1/skills.ts'
import { memberships, organizations, users } from '../src/server/d1/schema.ts'
import { oneShot } from '../src/server/one-shot.ts'
import { createSkillTool, turnSkills } from '../src/server/skills.ts'
import { hubAuthorize } from '../src/server/turns.ts'
import { d1Database, migrateD1 } from './sqlite.ts'

async function database() {
  const d1 = d1Database()
  await migrateD1(d1, new URL('../migrations/d1/', import.meta.url))
  const db = drizzle(d1 as never)
  await db.insert(users).values([
    { id: 'u1', displayName: 'Ada' },
    { id: 'u2', displayName: 'Grace' },
  ])
  await db.insert(organizations).values([
    { id: 'o1', name: 'Ada team' },
    { id: 'o2', name: 'Grace team' },
  ])
  await db.insert(memberships).values([
    { organizationId: 'o1', userId: 'u1', roles: [] },
    { organizationId: 'o2', userId: 'u2', roles: [] },
  ])
  return { d1, skills: d1Skills(db) }
}

const until = async (ready: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await ready()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

describe('skills in the database', () => {
  // A person sees their own skills, those of their organizations and those of the instance, and
  // nothing else; the model sees each name once, as the skill closest to the person.
  it('gives the model the visible skills, the closest one for each name', async () => {
    const { skills } = await database()
    const skill = (
      ownerId: string,
      visibility: 'private' | 'organization' | 'instance',
      name: string,
      body: string,
      organizationId: string | null = null,
    ) => skills.create({ ownerId, organizationId, visibility, name, description: `${name}.`, body })
    await skill('u2', 'instance', 'notes', 'Instance notes.')
    await skill('u2', 'instance', 'deploy', 'Deploy steps.')
    await skill('u1', 'organization', 'notes', 'Team notes.', 'o1')
    await skill('u1', 'private', 'notes', 'My notes.')
    await skill('u2', 'private', 'secret', 'Not for Ada.')
    await skill('u2', 'organization', 'other', 'Not for Ada either.', 'o2')

    const visible = await skills.visible('u1')
    expect(visible.map((s) => `${s.visibility}:${s.name}`).sort()).toEqual([
      'instance:deploy',
      'instance:notes',
      'organization:notes',
      'private:notes',
    ])
    const kit = turnSkills(visible)
    expect(kit.instructions).toContain('- notes: notes.')
    expect(kit.instructions).toContain('- deploy: deploy.')
    expect(kit.instructions.match(/- notes:/g)).toHaveLength(1)
    const [load] = kit.tools
    expect(await load?.run({ name: 'notes' })).toEqual([{ type: 'text', text: 'My notes.' }])
    expect(await load?.run({ name: 'deploy' })).toEqual([{ type: 'text', text: 'Deploy steps.' }])
  })

  // The model proposes a skill; it becomes one only once the person has read and approved it.
  it('saves a skill that the model creates only after the person approves it', async () => {
    const { d1, skills } = await database()
    const proposal = {
      name: 'weekly-report',
      description: 'Writes the weekly report.',
      instructions: 'List the done tasks, then the next ones.',
    }
    const model = scriptedModel((request) =>
      request.path.some((i) => i.kind === 'tool_result')
        ? { parts: [{ type: 'text', text: 'Done.' }] }
        : { parts: [{ type: 'tool_call', callId: 'k1', tool: 'create_skill', input: proposal }] },
    )
    const harness = createHarness({
      model,
      tools: [createSkillTool(skills, 'u1')],
      authorize: hubAuthorize,
    })
    const command = async (commandId: string, body: object) => {
      const { transport, result } = oneShot({ token: 't' }, {
        kind: 'command',
        sessionId: 's1',
        commandId,
        clientSeq: 0,
        conversationId: 'c1',
        command: body,
      } as never)
      void harness.serve(transport)
      expect((await result).ack).toMatchObject({ ok: true })
    }
    const items = async () => (await harness.store.load('c1', 0)).items
    const saved = () => d1.sqlite.prepare('SELECT name, visibility, body FROM skills').all()

    await command('m1', { t: 'send', parentId: null, parts: [{ type: 'text', text: 'Go.' }] })
    await until(async () =>
      (await items()).some((i) => i.kind === 'tool_call' && i.tool === 'approve'),
    )
    const approval = (await items()).find((i) => i.kind === 'tool_call' && i.tool === 'approve')
    expect(JSON.stringify(approval)).toContain(proposal.instructions)
    expect(saved()).toEqual([])

    await command('m2', {
      t: 'answer',
      callId: (approval as { callId: string }).callId,
      value: true,
    })
    await until(async () => saved().length > 0)
    expect(saved()).toEqual([
      { name: 'weekly-report', visibility: 'private', body: proposal.instructions },
    ])
  })
})
