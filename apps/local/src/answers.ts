// Terminal questions: the text shown for a question, and the reading of what the person types
// in reply. Pure, so that it can be tested without a terminal.

import type { AskUserAnswer, AskUserInput } from '@wica/tools-user'

export type Parsed<T> = { ok: T } | { error: string }

const YES = ['y', 'yes']
const NO = ['n', 'no']

export function parseYesNo(line: string): Parsed<boolean> {
  const word = line.trim().toLowerCase()
  if (YES.includes(word)) return { ok: true }
  if (NO.includes(word)) return { ok: false }
  return { error: 'Answer y (yes) or n (no).' }
}

/** Text of the question, numbered options, and what the person must type. */
export function prompt(input: AskUserInput): string {
  switch (input.kind) {
    case 'choice':
    case 'multiple': {
      const lines = input.options.map(
        (o, i) => `  ${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ''}`,
      )
      const how = input.kind === 'choice' ? 'Type a number.' : 'Type numbers separated by commas.'
      return [input.question, ...lines, how].join('\n')
    }
    case 'confirm':
      return `${input.question} [y/n]`
    case 'text':
      return input.question
    case 'form':
      return input.question
  }
}

/** Reads the answer to a question that fits on one line; a form goes through `parseField`. */
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
        return { error: `Choose between 1 and ${input.options.length}.` }
      }
      const labels = numbers.map((n) => input.options[n - 1]!.label)
      if (input.kind === 'choice') {
        return numbers.length === 1
          ? { ok: { kind: 'choice', label: labels[0]! } }
          : { error: 'Only one number.' }
      }
      return { ok: { kind: 'multiple', labels } }
    }
    case 'form':
      return { error: 'A form is filled in field by field.' }
  }
}

type Field = Extract<AskUserInput, { kind: 'form' }>['fields'][number]

/** Reads the value of a form field; an empty line leaves an optional field empty. */
export function parseField(field: Field, line: string): Parsed<string | number | boolean | null> {
  const raw = line.trim()
  if (raw === '') return field.required ? { error: 'This field is required.' } : { ok: null }
  switch (field.type) {
    case 'string':
      return { ok: raw }
    case 'number': {
      const n = Number(raw.replace(',', '.'))
      return Number.isFinite(n) ? { ok: n } : { error: 'A number is expected.' }
    }
    case 'boolean':
      return parseYesNo(raw)
    case 'choice': {
      const options = field.options ?? []
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return { ok: options[n - 1]! }
      return options.includes(raw) ? { ok: raw } : { error: `Choose among: ${options.join(', ')}.` }
    }
  }
}

/** Field of an MCP information request; `list`: several values separated by commas. */
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
 * Fields to ask for the `requestedSchema` of an MCP request in form mode: MCP allows there only
 * top-level properties of type text, number, boolean or enumeration.
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

/** Reads an MCP request field; a list keeps the non-empty values, in the order typed. */
export function parseElicitField(
  field: ElicitField,
  line: string,
): Parsed<string | number | boolean | string[] | null> {
  if (!field.list) return parseField(field, line)
  const values = line
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (values.length === 0)
    return field.required ? { error: 'This field is required.' } : { ok: null }
  const unknown = field.options ? values.filter((v) => !field.options!.includes(v)) : []
  return unknown.length > 0
    ? { error: `Choose among: ${field.options!.join(', ')}.` }
    : { ok: values }
}
