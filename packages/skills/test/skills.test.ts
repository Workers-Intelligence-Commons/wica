import { describe, expect, it } from 'vite-plus/test'

import { loadSkills, parseSkill, SkillFormatError, skillsKit } from '../src/index.ts'

const files: Record<string, string> = {
  'skills/pdf-forms/SKILL.md': [
    '---',
    'name: pdf-forms',
    'description: >',
    '  Remplit des formulaires PDF.',
    '  À utiliser quand la personne fournit un PDF à compléter.',
    'license: MIT',
    'allowed-tools: read_file bash',
    'metadata:',
    '  author: wica',
    '---',
    '',
    '# Formulaires',
    '',
    'Lire `reference/champs.md` avant de commencer.',
  ].join('\r\n'),
  'skills/pdf-forms/reference/champs.md': 'Liste des champs.',
}

const read = async (path: string) => {
  const text = files[path]
  if (text === undefined) throw new Error(`absent : ${path}`)
  return text
}

describe('parseSkill', () => {
  it('lit l’en-tête et le corps d’un SKILL.md', () => {
    const { descriptor, body } = parseSkill(files['skills/pdf-forms/SKILL.md']!, 'skills/pdf-forms')
    expect(descriptor).toEqual({
      name: 'pdf-forms',
      description:
        'Remplit des formulaires PDF. À utiliser quand la personne fournit un PDF à compléter.',
      location: 'skills/pdf-forms',
      license: 'MIT',
      metadata: { author: 'wica' },
      allowedTools: ['read_file', 'bash'],
    })
    expect(body).toBe('# Formulaires\n\nLire `reference/champs.md` avant de commencer.')
  })

  it('refuse un nom qui ne correspond pas au dossier', () => {
    expect(() => parseSkill('---\nname: autre\ndescription: x\n---\n', 'skills/pdf-forms')).toThrow(
      SkillFormatError,
    )
  })
})

describe('skillsKit', () => {
  it('ne donne que nom et description, puis charge le skill et ses fichiers à la demande', async () => {
    const skills = await loadSkills(['skills/pdf-forms'], read)
    const kit = skillsKit(skills, read)
    expect(kit.instructions).toContain('- pdf-forms : Remplit des formulaires PDF.')
    expect(kit.instructions).not.toContain('Formulaires')

    const [tool] = kit.tools
    expect(await tool!.run({ name: 'pdf-forms' })).toEqual([
      { type: 'text', text: '# Formulaires\n\nLire `reference/champs.md` avant de commencer.' },
    ])
    expect(await tool!.run({ name: 'pdf-forms', file: 'reference/champs.md' })).toEqual([
      { type: 'text', text: 'Liste des champs.' },
    ])
  })

  it('refuse un fichier hors du dossier du skill', async () => {
    const kit = skillsKit(await loadSkills(['skills/pdf-forms'], read), read)
    await expect(kit.tools[0]!.run({ name: 'pdf-forms', file: '../../secret' })).rejects.toThrow(
      SkillFormatError,
    )
  })
})
