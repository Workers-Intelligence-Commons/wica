// Faux modèles pour essayer une application sans vrai modèle ni serveur de modèle : du lorem
// ipsum écrit à l'avance, envoyé mot par mot comme un flux. Ce module n'importe rien d'autre que
// le cœur, pour qu'une application puisse l'embarquer sans le reste du paquet de test.

import {
  type AssistantMessage,
  CANCEL_WAKEUP_TOOL,
  ELICIT_TOOL,
  type JSONSchema,
  type ModelRequest,
  SCHEDULE_TOOL,
  type ToolSpec,
} from '@wica/core'
import type { ModelAdapter, ModelChunk } from '@wica/runtime'

/**
 * `lorem` répond en texte. `lorem-tools` appelle à chaque tour un outil de la requête, à tour de
 * rôle, puis répond en texte une fois son résultat reçu.
 */
export const LOREM_MODELS = ['lorem', 'lorem-tools'] as const
export type LoremModel = (typeof LOREM_MODELS)[number]

export const isLoremModel = (id: string): id is LoremModel =>
  (LOREM_MODELS as readonly string[]).includes(id)

const PARAGRAPHS = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
]

const SENTENCE = 'Lorem ipsum dolor sit amet.'

/**
 * Outils que `lorem-tools` n'appelle jamais : une question ou une demande attendrait la
 * personne, et un réveil relancerait le modèle sans elle.
 */
const SKIPPED = new Set(['ask_user', ELICIT_TOOL, SCHEDULE_TOOL, CANCEL_WAKEUP_TOOL])

export function loremModel(kind: LoremModel, options: { delayMs?: number } = {}): ModelAdapter {
  const delayMs = options.delayMs ?? 30
  return {
    async *stream(request, signal): AsyncIterable<ModelChunk> {
      const message = respond(kind, request)
      for (const part of message.parts) {
        if (part.type !== 'text') continue
        for (const word of part.text.split(/(?<=\s)/)) {
          await sleep(delayMs, signal)
          yield { type: 'text', text: word }
        }
      }
      signal.throwIfAborted()
      yield { type: 'done', message }
    },
  }
}

function respond(kind: LoremModel, request: ModelRequest): AssistantMessage {
  if (request.summarize) return { parts: [{ type: 'text', text: `Summary. ${SENTENCE}` }] }
  const replies = request.path.filter((i) => i.kind === 'assistant_text').length
  const text = [0, 1].map((n) => PARAGRAPHS[(replies + n) % PARAGRAPHS.length]).join('\n\n')
  const last = request.path.at(-1)
  if (kind === 'lorem' || last?.kind === 'tool_result') return { parts: [{ type: 'text', text }] }
  const tools = request.tools.filter((t) => !SKIPPED.has(t.name))
  const calls = request.path.filter((i) => i.kind === 'tool_call').length
  const tool = tools[calls % tools.length]
  if (!tool) return { parts: [{ type: 'text', text }] }
  return {
    parts: [
      { type: 'text', text: `${SENTENCE} Calling ${tool.name}.` },
      {
        type: 'tool_call',
        callId: `lorem-${request.trigger}`,
        tool: tool.name,
        input: input(tool),
      },
    ],
  }
}

/** Entrée qui satisfait les champs requis du schéma de l'outil, remplie de lorem. */
function input(tool: ToolSpec): Record<string, unknown> {
  const schema = tool.inputSchema as {
    properties?: Record<string, JSONSchema>
    required?: string[]
  }
  return Object.fromEntries(
    (schema.required ?? []).map((name) => [name, sample(schema.properties?.[name] ?? {})]),
  )
}

function sample(schema: JSONSchema): unknown {
  const s = schema as { type?: string; enum?: unknown[] }
  if (s.enum?.length) return s.enum[0]
  if (s.type === 'number' || s.type === 'integer') return 1
  if (s.type === 'boolean') return false
  if (s.type === 'array') return []
  if (s.type === 'object') return {}
  return SENTENCE
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
