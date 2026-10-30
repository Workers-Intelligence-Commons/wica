// Faux modèle et faux outils pour les tests.

import type { AssistantMessage, Item, ModelRequest } from '@wica/core'
import type { ModelAdapter, ModelChunk, Tool } from '@wica/runtime'

/**
 * Faux modèle scripté : `respond` choisit la réponse depuis la requête, et chaque partie de
 * texte est envoyée en deux deltas avant la réponse complète.
 */
export function scriptedModel(
  respond: (request: ModelRequest) => AssistantMessage,
): ModelAdapter & {
  requests: ModelRequest[]
} {
  const requests: ModelRequest[] = []
  return {
    requests,
    async *stream(request): AsyncIterable<ModelChunk> {
      requests.push(request)
      const message = respond(request)
      for (const part of message.parts) {
        if (part.type !== 'text' && part.type !== 'reasoning') continue
        const content = part.text ?? ''
        const half = Math.ceil(content.length / 2)
        for (const piece of [content.slice(0, half), content.slice(half)]) {
          if (piece) yield { type: part.type, text: piece }
        }
      }
      yield { type: 'done', message }
    },
  }
}

/** Dernier élément du chemin envoyé au modèle. */
export const lastItem = (request: ModelRequest): Item | undefined =>
  request.path[request.path.length - 1]

/** Faux système de fichiers en mémoire, avec un outil de lecture. */
export function memoryFiles(files: Record<string, string>): Tool {
  return {
    spec: {
      name: 'read_file',
      description: 'Lit un fichier texte.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      annotations: { readOnlyHint: true },
      channel: 'environment',
    },
    run: async (input) => {
      const path = (input as { path: string }).path
      const content = files[path]
      if (content === undefined) throw new Error(`Fichier absent : ${path}`)
      return [{ type: 'text', text: content }]
    },
  }
}

export * from './open-responses.ts'
export * from './conformance.ts'
