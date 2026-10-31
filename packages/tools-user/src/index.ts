// User channel tools: `ask_user` asks a question that the client shows, `say` speaks to the person.
// The declarations are pure; only `say` has a function, which acknowledges receipt.

import { ELICIT_TOOL, type Item, type Part, type ToolSpec } from '@wica/core'

export const ASK_USER_TOOL = 'ask_user'
export const SAY_TOOL = 'say'

export type AskOption = { label: string; description?: string; preview?: string }

export type AskField = {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'choice'
  options?: string[]
  required?: boolean
}

export type AskUserInput =
  | { kind: 'choice' | 'multiple'; question: string; options: AskOption[] }
  | { kind: 'text'; question: string; placeholder?: string }
  | { kind: 'confirm'; question: string }
  | { kind: 'form'; question: string; fields: AskField[] }

/** Value the client sends back through `answer`, according to the kind of question. */
export type AskUserAnswer =
  | { kind: 'choice'; label: string }
  | { kind: 'multiple'; labels: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'confirm'; yes: boolean }
  | { kind: 'form'; values: Record<string, string | number | boolean> }

export type SayInput = { text: string }

const option = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    description: { type: 'string' },
    preview: { type: 'string', description: 'Preview shown when the option is in view.' },
  },
  required: ['label'],
}

export const askUserSpec: ToolSpec = {
  name: ASK_USER_TOOL,
  description:
    'Asks the person a question and waits for their answer: single or multiple choice, free text, confirmation, or a form with typed fields.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['choice', 'multiple', 'text', 'confirm', 'form'] },
      question: { type: 'string' },
      options: { type: 'array', items: option },
      placeholder: { type: 'string' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['string', 'number', 'boolean', 'choice'] },
            options: { type: 'array', items: { type: 'string' } },
            required: { type: 'boolean' },
          },
          required: ['name', 'label', 'type'],
        },
      },
    },
    required: ['kind', 'question'],
  },
  annotations: { readOnlyHint: true },
  channel: 'user',
  runsOn: 'client',
  speaker: 'user',
}

export const saySpec: ToolSpec = {
  name: SAY_TOOL,
  description: 'Says a message to the person. Free text stays private: only this message is seen.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  channel: 'user',
  runsOn: 'server',
}

/** `say` ready for `createHarness`: the message is the call itself, the result an acknowledgement. */
export const say = {
  spec: saySpec,
  run: async (): Promise<Part[]> => [{ type: 'text', text: 'Message delivered.' }],
}

/** `ask_user` ready for `createHarness`: only declared, it runs on the client. */
export const askUser = { spec: askUserSpec }

/** User channel tools, in a stable order. */
export const userTools = [askUser, say]

const words = (answer: AskUserAnswer): string => {
  switch (answer.kind) {
    case 'choice':
      return answer.label
    case 'multiple':
      return answer.labels.length > 0 ? answer.labels.join(', ') : 'No option.'
    case 'text':
      return answer.text
    case 'confirm':
      return answer.yes ? 'Yes.' : 'No.'
    case 'form':
      return Object.entries(answer.values)
        .map(
          ([name, value]) =>
            `${name}: ${typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}`,
        )
        .join('\n')
  }
}

const isAnswer = (value: unknown): value is AskUserAnswer =>
  typeof value === 'object' &&
  value !== null &&
  ['choice', 'multiple', 'text', 'confirm', 'form'].includes(
    (value as { kind?: string }).kind ?? '',
  )

/** Answer to an information request of an MCP server (MCP `ElicitResult` shape). */
export type ElicitAnswer = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, string | number | boolean | string[]>
}

const isElicitResult = (value: unknown): value is ElicitAnswer =>
  typeof value === 'object' &&
  value !== null &&
  ['accept', 'decline', 'cancel'].includes((value as { action?: string }).action ?? '')

const elicitWords = (answer: ElicitAnswer): string => {
  if (answer.action === 'decline') return 'I refuse to answer.'
  if (answer.action === 'cancel') return 'Cancelled.'
  const fields = Object.entries(answer.content ?? {})
  if (fields.length === 0) return 'Yes.'
  return fields
    .map(([name, value]) => {
      const shown = Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'boolean'
          ? value
            ? 'yes'
            : 'no'
          : String(value)
      return `${name}: ${shown}`
    })
    .join('\n')
}

/**
 * Renders an answer from the person into journal parts, in their words: this is what the model
 * will read as their speech. To pass as `renderAnswer` to `createHarness`.
 */
export function renderAnswer(
  call: Extract<Item, { kind: 'tool_call' }> | undefined,
  value: unknown,
): Part[] {
  if (call?.tool === ASK_USER_TOOL && isAnswer(value)) {
    return [{ type: 'text', text: words(value) }]
  }
  if (call?.tool === ELICIT_TOOL && isElicitResult(value)) {
    return [{ type: 'text', text: elicitWords(value) }]
  }
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}
