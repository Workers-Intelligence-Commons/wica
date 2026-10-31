// Skills in the open Agent Skills format. The host provides the locations and a read function;
// this package parses the `SKILL.md` files, writes the list given to the model (name and
// description only) and provides the tool that loads a skill when the task matches it. It does
// not touch the file system itself.

import type { Part, ToolSpec } from '@wica/core'
import { parse } from 'yaml'

export type SkillDescriptor = {
  name: string
  description: string
  /** Folder of the skill, as the host read function understands it. */
  location: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
}

/** Read of a file by the host: local path, address or storage key. */
export type ReadFile = (path: string) => Promise<string>

export class SkillFormatError extends Error {
  override name = 'SkillFormatError'
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

const lastSegment = (location: string) => location.replace(/\/+$/, '').split('/').at(-1) ?? ''

const join = (location: string, file: string) => `${location.replace(/\/+$/, '')}/${file}`

/** Separates the YAML header from the body and validates the fields of the Agent Skills specification. */
export function parseSkill(
  text: string,
  location: string,
): { descriptor: SkillDescriptor; body: string } {
  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source)
  if (!match) throw new SkillFormatError(`${location}: SKILL.md without a YAML header`)
  let header: unknown
  try {
    header = parse(match[1] ?? '')
  } catch (error) {
    throw new SkillFormatError(
      `${location}: unreadable YAML header (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new SkillFormatError(`${location}: the YAML header must be an object`)
  }
  const h = header as Record<string, unknown>
  const fail = (message: string) => new SkillFormatError(`${location} : ${message}`)

  const name = h['name']
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !NAME.test(name)) {
    throw fail('`name` must be 1 to 64 characters: lowercase letters, digits and single hyphens')
  }
  if (name !== lastSegment(location)) {
    throw fail(`\`name\` (${name}) must be the name of the folder (${lastSegment(location)})`)
  }
  const description = h['description']
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) {
    throw fail('`description` must be 1 to 1024 characters')
  }
  const descriptor: SkillDescriptor = { name, description: description.trim(), location }
  if (typeof h['license'] === 'string') descriptor.license = h['license']
  const compatibility = h['compatibility']
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string' || compatibility.length > 500) {
      throw fail('`compatibility` must be at most 500 characters')
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
      throw fail('`metadata` must map keys to texts')
    }
    descriptor.metadata = metadata as Record<string, string>
  }
  const allowed = h['allowed-tools']
  if (allowed !== undefined) {
    if (typeof allowed !== 'string')
      throw fail('`allowed-tools` must be a list separated by spaces')
    descriptor.allowedTools = allowed.split(/\s+/).filter(Boolean)
  }
  return { descriptor, body: (match[2] ?? '').trim() }
}

/** Reads the header of each skill; a duplicate name is a configuration error. */
export async function loadSkills(locations: string[], read: ReadFile): Promise<SkillDescriptor[]> {
  const skills = await Promise.all(
    locations.map(
      async (location) => parseSkill(await read(join(location, 'SKILL.md')), location).descriptor,
    ),
  )
  const seen = new Set<string>()
  for (const skill of skills) {
    if (seen.has(skill.name)) throw new SkillFormatError(`skill ${skill.name} provided twice`)
    seen.add(skill.name)
  }
  return skills
}

export const LOAD_SKILL_TOOL = 'load_skill'

/** List given to the model at startup: name and description of each skill, nothing else. */
export function skillsInstructions(skills: SkillDescriptor[]): string {
  if (skills.length === 0) return ''
  return [
    'Available skills. When the task matches the description of a skill, load its ' +
      `instructions with the \`${LOAD_SKILL_TOOL}\` tool before acting; its linked files load ` +
      'with the same tool and the `file` parameter.',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n')
}

/** Path relative to the skill folder, without going up and without an absolute path. */
function safeRelative(file: string): string {
  const segments = file.split('/')
  if (
    file.startsWith('/') ||
    /^[a-zA-Z]:/.test(file) ||
    file.includes('\\') ||
    segments.some((s) => s === '..' || s === '')
  ) {
    throw new SkillFormatError(`path refused: ${file} (relative to the skill folder, without "..")`)
  }
  return file
}

type SkillTool = {
  spec: ToolSpec
  run: (input: unknown) => Promise<Part[]>
}

/**
 * Instructions and loading tool for `createHarness({ skills })`. The full `SKILL.md` is read only
 * at loading, and the linked files only when the model asks for them.
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
      description: 'Loads the full instructions of a skill, or a file of its folder with `file`.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: skills.map((s) => s.name) },
          file: { type: 'string', description: 'Path relative to the skill folder.' },
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
      if (!skill) throw new SkillFormatError(`unknown skill: ${String(name)}`)
      if (file !== undefined) {
        if (typeof file !== 'string') throw new SkillFormatError('`file` must be a text')
        return [{ type: 'text', text: await read(join(skill.location, safeRelative(file))) }]
      }
      const { body } = parseSkill(await read(join(skill.location, 'SKILL.md')), skill.location)
      return [{ type: 'text', text: body }]
    },
  }
  return { instructions: skillsInstructions(skills), tools: [tool] }
}
