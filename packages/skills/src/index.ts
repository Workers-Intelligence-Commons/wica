// Skills au format ouvert Agent Skills. L'hôte fournit les
// emplacements et une fonction de lecture ; ce paquet analyse les `SKILL.md`, rédige la liste
// donnée au modèle (nom et description seulement) et fournit l'outil qui charge un skill quand la
// tâche y correspond. Il ne touche pas au système de fichiers lui-même.

import type { Part, ToolSpec } from '@wica/core'
import { parse } from 'yaml'

export type SkillDescriptor = {
  name: string
  description: string
  /** Dossier du skill, tel que la fonction de lecture de l'hôte le comprend. */
  location: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
}

/** Lecture d'un fichier par l'hôte : chemin local, adresse ou clé de stockage. */
export type ReadFile = (path: string) => Promise<string>

export class SkillFormatError extends Error {
  override name = 'SkillFormatError'
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

const lastSegment = (location: string) => location.replace(/\/+$/, '').split('/').at(-1) ?? ''

const join = (location: string, file: string) => `${location.replace(/\/+$/, '')}/${file}`

/** Sépare l'en-tête YAML du corps et valide les champs de la spécification Agent Skills. */
export function parseSkill(
  text: string,
  location: string,
): { descriptor: SkillDescriptor; body: string } {
  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new SkillFormatError(`${location} : SKILL.md sans en-tête YAML`)
  let header: unknown
  try {
    header = parse(match[1] ?? '')
  } catch (error) {
    throw new SkillFormatError(
      `${location} : en-tête YAML illisible (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new SkillFormatError(`${location} : l'en-tête YAML doit être un objet`)
  }
  const h = header as Record<string, unknown>
  const fail = (message: string) => new SkillFormatError(`${location} : ${message}`)

  const name = h['name']
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !NAME.test(name)) {
    throw fail(
      '`name` doit faire 1 à 64 caractères : minuscules, chiffres et traits d’union isolés',
    )
  }
  if (name !== lastSegment(location)) {
    throw fail(`\`name\` (${name}) doit être le nom du dossier (${lastSegment(location)})`)
  }
  const description = h['description']
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) {
    throw fail('`description` doit faire 1 à 1024 caractères')
  }
  const descriptor: SkillDescriptor = { name, description: description.trim(), location }
  if (typeof h['license'] === 'string') descriptor.license = h['license']
  const compatibility = h['compatibility']
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string' || compatibility.length > 500) {
      throw fail('`compatibility` doit faire au plus 500 caractères')
    }
    descriptor.compatibility = compatibility
  }
  const metadata = h['metadata']
  if (metadata !== undefined) {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.values(metadata).some((v) => typeof v !== 'string')
    ) {
      throw fail('`metadata` doit associer des clés à des textes')
    }
    descriptor.metadata = metadata as Record<string, string>
  }
  const allowed = h['allowed-tools']
  if (allowed !== undefined) {
    if (typeof allowed !== 'string')
      throw fail('`allowed-tools` doit être une liste séparée par des espaces')
    descriptor.allowedTools = allowed.split(/\s+/).filter(Boolean)
  }
  return { descriptor, body: (match[2] ?? '').trim() }
}

/** Lit l'en-tête de chaque skill ; un nom en double est une erreur de configuration. */
export async function loadSkills(locations: string[], read: ReadFile): Promise<SkillDescriptor[]> {
  const skills = await Promise.all(
    locations.map(
      async (location) => parseSkill(await read(join(location, 'SKILL.md')), location).descriptor,
    ),
  )
  const seen = new Set<string>()
  for (const skill of skills) {
    if (seen.has(skill.name)) throw new SkillFormatError(`skill ${skill.name} fourni deux fois`)
    seen.add(skill.name)
  }
  return skills
}

export const LOAD_SKILL_TOOL = 'load_skill'

/** Liste donnée au modèle au démarrage : nom et description de chaque skill, rien d'autre. */
export function skillsInstructions(skills: SkillDescriptor[]): string {
  if (skills.length === 0) return ''
  return [
    'Skills disponibles. Quand la tâche correspond à la description d’un skill, charge ses ' +
      `instructions avec l’outil \`${LOAD_SKILL_TOOL}\` avant d’agir ; ses fichiers liés se ` +
      'chargent avec le même outil et le paramètre `file`.',
    ...skills.map((s) => `- ${s.name} : ${s.description}`),
  ].join('\n')
}

/** Chemin relatif au dossier du skill, sans remontée ni chemin absolu. */
function safeRelative(file: string): string {
  const segments = file.split('/')
  if (
    file.startsWith('/') ||
    /^[a-zA-Z]:/.test(file) ||
    file.includes('\\') ||
    segments.some((s) => s === '..' || s === '')
  ) {
    throw new SkillFormatError(`chemin refusé : ${file} (relatif au dossier du skill, sans « .. »)`)
  }
  return file
}

type SkillTool = {
  spec: ToolSpec
  run: (input: unknown) => Promise<Part[]>
}

/**
 * Consignes et outil de chargement pour `createHarness({ skills })`. Le `SKILL.md` complet n'est
 * lu qu'au chargement, et les fichiers liés seulement quand le modèle les demande.
 */
export function skillsKit(
  skills: SkillDescriptor[],
  read: ReadFile,
): { instructions: string; tools: SkillTool[] } {
  if (skills.length === 0) return { instructions: '', tools: [] }
  const byName = new Map(skills.map((s) => [s.name, s]))
  const tool: SkillTool = {
    spec: {
      name: LOAD_SKILL_TOOL,
      description:
        'Charge les instructions complètes d’un skill, ou un fichier de son dossier avec `file`.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: skills.map((s) => s.name) },
          file: { type: 'string', description: 'Chemin relatif au dossier du skill.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      channel: 'environment',
      runsOn: 'server',
    },
    run: async (input) => {
      const { name, file } = (input ?? {}) as { name?: unknown; file?: unknown }
      const skill = typeof name === 'string' ? byName.get(name) : undefined
      if (!skill) throw new SkillFormatError(`skill inconnu : ${String(name)}`)
      if (file !== undefined) {
        if (typeof file !== 'string') throw new SkillFormatError('`file` doit être un texte')
        return [{ type: 'text', text: await read(join(skill.location, safeRelative(file))) }]
      }
      const { body } = parseSkill(await read(join(skill.location, 'SKILL.md')), skill.location)
      return [{ type: 'text', text: body }]
    },
  }
  return { instructions: skillsInstructions(skills), tools: [tool] }
}
