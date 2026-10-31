import { describe, expect, it } from 'vite-plus/test'

import { loadSkills, parseSkill, SkillFormatError, skillsKit } from '../src/index.ts'

const files: Record<string, string> = {
  'skills/pdf-forms/SKILL.md': [
    '---',
    'name: pdf-forms',
    'description: >',
    '  Fills in PDF forms.',
    '  Use when the person provides a PDF to complete.',
    'license: MIT',
    'allowed-tools: read_file bash',
    'metadata:',
    '  author: wica',
    '---',
    '',
    '# Forms',
    '',
    'Read `reference/fields.md` before starting.',
  ].join('\r\n'),
  'skills/pdf-forms/reference/fields.md': 'List of the fields.',
}

const read = async (path: string) => {
  const text = files[path]
  if (text === undefined) throw new Error(`absent: ${path}`)
  return text
}

describe('parseSkill', () => {
  it('reads the header and the body of a SKILL.md', () => {
    const { descriptor, body } = parseSkill(files['skills/pdf-forms/SKILL.md']!, 'skills/pdf-forms')
    expect(descriptor).toEqual({
      name: 'pdf-forms',
      description: 'Fills in PDF forms. Use when the person provides a PDF to complete.',
      location: 'skills/pdf-forms',
      license: 'MIT',
      metadata: { author: 'wica' },
      allowedTools: ['read_file', 'bash'],
    })
    expect(body).toBe('# Forms\n\nRead `reference/fields.md` before starting.')
  })

  it('refuses a name that does not match the folder', () => {
    expect(() => parseSkill('---\nname: other\ndescription: x\n---\n', 'skills/pdf-forms')).toThrow(
      SkillFormatError,
    )
  })
})

describe('skillsKit', () => {
  it('gives only name and description, then loads the skill and its files on demand', async () => {
    const skills = await loadSkills(['skills/pdf-forms'], read)
    const kit = skillsKit(skills, read)
    expect(kit.instructions).toContain('- pdf-forms: Fills in PDF forms.')
    expect(kit.instructions).not.toContain('Forms')

    const [tool] = kit.tools
    expect(await tool!.run({ name: 'pdf-forms' })).toEqual([
      { type: 'text', text: '# Forms\n\nRead `reference/fields.md` before starting.' },
    ])
    expect(await tool!.run({ name: 'pdf-forms', file: 'reference/fields.md' })).toEqual([
      { type: 'text', text: 'List of the fields.' },
    ])
  })

  it('refuses a file outside the skill folder', async () => {
    const kit = skillsKit(await loadSkills(['skills/pdf-forms'], read), read)
    await expect(kit.tools[0]!.run({ name: 'pdf-forms', file: '../../secret' })).rejects.toThrow(
      SkillFormatError,
    )
  })
})
