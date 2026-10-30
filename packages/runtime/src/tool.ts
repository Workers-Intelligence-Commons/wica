// Outils et autorisation.

import {
  CANCEL_WAKEUP_TOOL,
  type Item,
  type JSONSchema,
  type Part,
  SCHEDULE_TOOL,
  type ToolAnnotations,
  type ToolCall,
  type ToolSpec,
  type Trust,
} from '@wica/core'

export type ToolContext = {
  callId: string
  signal: AbortSignal
  /** Message de progression vers le client, jamais vers le modèle. */
  progress: (message: string) => void
  /** Chemin actif, en lecture seule. */
  path: readonly Item[]
  /**
   * Pose une question à la personne pendant l'outil (demande d'information d'un serveur MCP) et
   * rend sa réponse. La question passe par le canal utilisateur ; la réponse compte comme sa parole.
   */
  ask: (input: unknown) => Promise<unknown>
}

export type Tool = {
  spec: ToolSpec
  /** Absent : l'outil est seulement déclaré et s'exécute ailleurs. */
  run?: (input: unknown, ctx: ToolContext) => Promise<Part[]>
}

type Issue = { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }

/** Schéma conforme à Standard Schema et à Standard JSON Schema (Zod, Valibot, ArkType…). */
export type StandardToolSchema<I = unknown, O = I> = {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly types?: { readonly input: I; readonly output: O }
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: O; readonly issues?: undefined }
      | { readonly issues: readonly Issue[] }
      | Promise<
          { readonly value: O; readonly issues?: undefined } | { readonly issues: readonly Issue[] }
        >
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>
    }
  }
}

export class ToolInputError extends Error {
  override name = 'ToolInputError'
}

type ToolDefinition<O> = {
  name: string
  description: string
  annotations?: ToolAnnotations
  channel?: 'environment' | 'user'
  runsOn?: 'server' | 'client'
  run?: (input: O, ctx: ToolContext) => Promise<Part[] | string>
}

const asParts = (out: Part[] | string): Part[] =>
  typeof out === 'string' ? [{ type: 'text', text: out }] : out

/** Un outil : un nom, une description, un schéma et une fonction. */
export function defineTool<O>(
  definition: ToolDefinition<O> & { input: StandardToolSchema<unknown, O> },
): Tool
/** Variante en JSON Schema brut (outils MCP) : la validation revient à celui qui exécute. */
export function defineTool(definition: ToolDefinition<unknown> & { input: JSONSchema }): Tool
export function defineTool(
  definition: ToolDefinition<unknown> & { input: StandardToolSchema | JSONSchema },
): Tool {
  const schema = definition.input
  const standard =
    typeof schema === 'object' && schema !== null && '~standard' in schema
      ? (schema as StandardToolSchema)['~standard']
      : undefined
  const spec: ToolSpec = {
    name: definition.name,
    description: definition.description,
    inputSchema: standard
      ? standard.jsonSchema.input({ target: 'draft-2020-12' })
      : (schema as JSONSchema),
    channel: definition.channel ?? 'environment',
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    ...(definition.runsOn ? { runsOn: definition.runsOn } : {}),
  }
  const run = definition.run
  if (!run) return { spec }
  return {
    spec,
    run: async (input, ctx) => {
      let value = input
      if (standard) {
        const result = await standard.validate(input)
        if (result.issues) {
          // Un échec de validation devient un résultat d'erreur pour le modèle, jamais une exception.
          throw new ToolInputError(
            `Arguments invalides : ${result.issues.map((i) => i.message).join(' ; ')}`,
          )
        }
        value = result.value
      }
      return asParts(await run(value, ctx))
    },
  }
}

export type AuthorizeDecision = 'allow' | 'deny' | { deny: string } | { ask: string }

export type AuthorizeContext = {
  /** Confiance de l'entrée qui a déclenché le tour. */
  trust: Trust
  /** Vrai quand un client est attaché à la conversation. */
  attached: boolean
}

export type AuthorizeCall = ToolCall & { annotations: ToolAnnotations }

export type Authorize = (
  call: AuthorizeCall,
  ctx: AuthorizeContext,
) => AuthorizeDecision | Promise<AuthorizeDecision>

/** Tout est autorisé : le choix est visible dans le code de l'hôte. */
export const allowAll: Authorize = () => 'allow'

/** Seuls les outils en lecture seule passent. */
export const readOnlyOnly: Authorize = (call) =>
  call.annotations.readOnlyHint
    ? 'allow'
    : { deny: 'Seuls les outils en lecture seule sont autorisés.' }

/**
 * Valeurs par défaut de MCP : sans annotation, un outil est destructif et touche le monde
 * ouvert ; un outil en lecture seule n'est jamais destructif.
 */
export const isDestructive = (a: ToolAnnotations) =>
  a.readOnlyHint !== true && a.destructiveHint !== false
export const isOpenWorld = (a: ToolAnnotations) => a.openWorldHint !== false

/**
 * Agent sans personne : ce qui est destructif ou touche le monde ouvert attend l'approbation de
 * l'approbateur désigné ; le reste passe. Avec `approvalTimeoutMs`, le silence vaut refus.
 */
export const unattended: Authorize = (call) =>
  isDestructive(call.annotations) || isOpenWorld(call.annotations)
    ? { ask: `Autoriser ${call.tool} ?` }
    : 'allow'

/**
 * Outils de réveil, fournis par le Harness : le cœur les exécute en écrivant le réveil dans le
 * journal, et l'hôte réveille la conversation à l'heure dite par son `Scheduler`.
 */
export const scheduleTools: Tool[] = [
  {
    spec: {
      name: SCHEDULE_TOOL,
      description:
        'Prévoit un réveil de cette conversation, à une date (at) ou après un délai (inSeconds), une fois ou tous les every. Au réveil, tu reçois payload et tu reprends seul.',
      inputSchema: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'Date ISO 8601.' },
          inSeconds: { type: 'number', minimum: 0, description: 'Délai en secondes.' },
          every: {
            type: 'string',
            description:
              'Récurrence, durée ISO 8601 en jours, heures, minutes ou secondes (PT15M, P1D).',
          },
          payload: { description: 'Ce que tu veux te rappeler au réveil.' },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      channel: 'environment',
    },
  },
  {
    spec: {
      name: CANCEL_WAKEUP_TOOL,
      description: 'Annule un réveil prévu, désigné par son identifiant.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      channel: 'environment',
    },
  },
]
