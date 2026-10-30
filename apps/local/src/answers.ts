// Questions au terminal : le texte affiché pour une question, et la lecture de ce que la
// personne tape en réponse. Pur, pour être testé sans terminal.

import type { AskUserAnswer, AskUserInput } from '@wica/tools-user'

export type Parsed<T> = { ok: T } | { error: string }

const YES = ['o', 'oui', 'y', 'yes']
const NO = ['n', 'non', 'no']

export function parseYesNo(line: string): Parsed<boolean> {
  const word = line.trim().toLowerCase()
  if (YES.includes(word)) return { ok: true }
  if (NO.includes(word)) return { ok: false }
  return { error: 'Réponds par o (oui) ou n (non).' }
}

/** Texte de la question, options numérotées, et ce que la personne doit taper. */
export function prompt(input: AskUserInput): string {
  switch (input.kind) {
    case 'choice':
    case 'multiple': {
      const lines = input.options.map(
        (o, i) => `  ${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ''}`,
      )
      const how =
        input.kind === 'choice' ? 'Tape un numéro.' : 'Tape des numéros séparés par des virgules.'
      return [input.question, ...lines, how].join('\n')
    }
    case 'confirm':
      return `${input.question} [o/n]`
    case 'text':
      return input.question
    case 'form':
      return input.question
  }
}

/** Lit la réponse à une question qui tient sur une ligne ; un formulaire passe par `parseField`. */
export function parseAnswer(input: AskUserInput, line: string): Parsed<AskUserAnswer> {
  switch (input.kind) {
    case 'confirm': {
      const yes = parseYesNo(line)
      return 'ok' in yes ? { ok: { kind: 'confirm', yes: yes.ok } } : yes
    }
    case 'text':
      return { ok: { kind: 'text', text: line } }
    case 'choice':
    case 'multiple': {
      const numbers = line
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map(Number)
      const valid = numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= input.options.length)
      if (!valid || numbers.length === 0) {
        return { error: `Choisis entre 1 et ${input.options.length}.` }
      }
      const labels = numbers.map((n) => input.options[n - 1]!.label)
      if (input.kind === 'choice') {
        return numbers.length === 1
          ? { ok: { kind: 'choice', label: labels[0]! } }
          : { error: 'Un seul numéro.' }
      }
      return { ok: { kind: 'multiple', labels } }
    }
    case 'form':
      return { error: 'Un formulaire se remplit champ par champ.' }
  }
}

type Field = Extract<AskUserInput, { kind: 'form' }>['fields'][number]

/** Lit la valeur d'un champ de formulaire ; une ligne vide laisse un champ facultatif vide. */
export function parseField(field: Field, line: string): Parsed<string | number | boolean | null> {
  const raw = line.trim()
  if (raw === '') return field.required ? { error: 'Ce champ est requis.' } : { ok: null }
  switch (field.type) {
    case 'string':
      return { ok: raw }
    case 'number': {
      const n = Number(raw.replace(',', '.'))
      return Number.isFinite(n) ? { ok: n } : { error: 'Un nombre est attendu.' }
    }
    case 'boolean':
      return parseYesNo(raw)
    case 'choice': {
      const options = field.options ?? []
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return { ok: options[n - 1]! }
      return options.includes(raw)
        ? { ok: raw }
        : { error: `Choisis parmi : ${options.join(', ')}.` }
    }
  }
}

/** Champ d'une demande d'information MCP ; `list` : plusieurs valeurs séparées par des virgules. */
export type ElicitField = Field & { list?: boolean }

type PropertySchema = {
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  oneOf?: { const?: unknown }[]
  items?: { enum?: unknown[]; anyOf?: { const?: unknown }[] }
}

const strings = (values: unknown[] | undefined) =>
  values?.filter((v): v is string => typeof v === 'string')

/**
 * Champs à demander pour le `requestedSchema` d'une demande MCP en mode formulaire : MCP n'y
 * admet que des propriétés de premier niveau de type texte, nombre, booléen ou énumération.
 */
export function elicitFields(schema: unknown): ElicitField[] {
  const s = (schema ?? {}) as { properties?: Record<string, PropertySchema>; required?: string[] }
  return Object.entries(s.properties ?? {}).map(([name, p]) => {
    const label = p.title ?? p.description ?? name
    const required = s.required?.includes(name) ?? false
    const options =
      strings(p.enum) ??
      strings(p.oneOf?.map((o) => o.const)) ??
      strings(p.items?.enum) ??
      strings(p.items?.anyOf?.map((o) => o.const))
    if (p.type === 'array')
      return { name, label, type: 'string', required, list: true, ...(options ? { options } : {}) }
    if (options) return { name, label, type: 'choice', options, required }
    if (p.type === 'number' || p.type === 'integer')
      return { name, label, type: 'number', required }
    if (p.type === 'boolean') return { name, label, type: 'boolean', required }
    return { name, label, type: 'string', required }
  })
}

/** Lit un champ de demande MCP ; une liste garde les valeurs non vides, dans l'ordre tapé. */
export function parseElicitField(
  field: ElicitField,
  line: string,
): Parsed<string | number | boolean | string[] | null> {
  if (!field.list) return parseField(field, line)
  const values = line
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (values.length === 0) return field.required ? { error: 'Ce champ est requis.' } : { ok: null }
  const unknown = field.options ? values.filter((v) => !field.options!.includes(v)) : []
  return unknown.length > 0
    ? { error: `Choisis parmi : ${field.options!.join(', ')}.` }
    : { ok: values }
}
