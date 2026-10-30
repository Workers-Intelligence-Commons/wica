// Outils du canal utilisateur (specs/harness.md, Paroles de la personne dans les résultats
// d'outils) : `ask_user` pose une question que le client affiche, `say` parle à la personne.
// Les déclarations sont pures ; seul `say` a une fonction, qui accuse réception.

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

/** Valeur que le client renvoie par `answer`, selon la sorte de question. */
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
    preview: { type: 'string', description: 'Aperçu montré quand l’option est en vue.' },
  },
  required: ['label'],
}

export const askUserSpec: ToolSpec = {
  name: ASK_USER_TOOL,
  description:
    'Pose une question à la personne et attend sa réponse : choix unique ou multiple, texte libre, confirmation, ou formulaire à champs typés.',
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
  description: 'Dit un message à la personne. Le texte libre reste privé : seul ce message est vu.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  annotations: { readOnlyHint: true },
  channel: 'user',
  runsOn: 'server',
}

/** `say` prêt pour `createHarness` : le message est l'appel lui-même, le résultat un accusé. */
export const say = {
  spec: saySpec,
  run: async (): Promise<Part[]> => [{ type: 'text', text: 'Message transmis.' }],
}

/** `ask_user` prêt pour `createHarness` : seulement déclaré, il s'exécute chez le client. */
export const askUser = { spec: askUserSpec }

/** Outils du canal utilisateur, dans un ordre stable. */
export const userTools = [askUser, say]

const words = (answer: AskUserAnswer): string => {
  switch (answer.kind) {
    case 'choice':
      return answer.label
    case 'multiple':
      return answer.labels.length > 0 ? answer.labels.join(', ') : 'Aucune option.'
    case 'text':
      return answer.text
    case 'confirm':
      return answer.yes ? 'Oui.' : 'Non.'
    case 'form':
      return Object.entries(answer.values)
        .map(
          ([name, value]) =>
            `${name} : ${typeof value === 'boolean' ? (value ? 'oui' : 'non') : value}`,
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

/** Réponse à une demande d'information d'un serveur MCP (forme `ElicitResult` de MCP). */
export type ElicitAnswer = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, string | number | boolean | string[]>
}

const isElicitResult = (value: unknown): value is ElicitAnswer =>
  typeof value === 'object' &&
  value !== null &&
  ['accept', 'decline', 'cancel'].includes((value as { action?: string }).action ?? '')

const elicitWords = (answer: ElicitAnswer): string => {
  if (answer.action === 'decline') return 'Je refuse de répondre.'
  if (answer.action === 'cancel') return 'Annulé.'
  const fields = Object.entries(answer.content ?? {})
  if (fields.length === 0) return 'Oui.'
  return fields
    .map(([name, value]) => {
      const shown = Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'boolean'
          ? value
            ? 'oui'
            : 'non'
          : String(value)
      return `${name} : ${shown}`
    })
    .join('\n')
}

/**
 * Rend une réponse de la personne en parties du journal, dans ses mots : c'est ce que le modèle
 * lira comme sa parole. À passer en `renderAnswer` à `createHarness`.
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
