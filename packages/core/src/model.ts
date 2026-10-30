import type { Item } from './journal.ts'

export type JSONSchema = Record<string, unknown> | boolean

/** Vocabulaire des annotations d'outils de MCP. */
export type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type ToolSpec = {
  name: string
  description: string
  inputSchema: JSONSchema
  annotations?: ToolAnnotations
  channel: 'environment' | 'user'
  runsOn?: 'server' | 'client'
  speaker?: 'user'
}

export type Delta = { type: 'text'; text: string } | { type: 'reasoning'; text: string }

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string; opaque?: { provider: string; data: unknown } }
  | { type: 'tool_call'; callId: string; tool: string; input: unknown }

export type AssistantMessage = { parts: AssistantPart[]; raw?: string }

export type ModelRequest = {
  /** Identifiant de l'élément auquel le modèle répond. */
  trigger: string
  /** Chemin actif, de la racine à la tête. */
  path: Item[]
  tools: ToolSpec[]
  /** Consignes de l'hôte pour le modèle, hors du journal. */
  instructions?: string
  /**
   * Requête de résumé : le modèle résume `path` sans outils, et son texte devient l'événement
   * `compacted` de cette plage au lieu d'une réponse.
   */
  summarize?: { from: string; to: string }
}

export type ToolCall = {
  callId: string
  tool: string
  input: unknown
  channel: 'environment' | 'user'
  /** Vrai quand la personne a déjà accordé cet appel : l'hôte ne redemande pas `authorize`. */
  approved?: boolean
}

/** Outil du canal utilisateur qui porte une demande d'approbation dans le journal. */
export const APPROVAL_TOOL = 'approve'

/** `callId` de la demande d'approbation liée à un appel d'outil. */
export const approvalCallId = (callId: string) => `approve:${callId}`

/**
 * Outil du canal utilisateur qui porte une question posée par un outil en cours, par exemple la
 * demande d'information d'un serveur MCP. Sa réponse revient à l'outil qui attend.
 */
export const ELICIT_TOOL = 'elicit'

/** `callId` de la question `n` posée pendant l'appel `callId`. */
export const elicitCallId = (callId: string, n: number) => `elicit:${callId}:${n}`

/** Outil intégré qui prévoit un réveil de la conversation (une fois ou récurrent). */
export const SCHEDULE_TOOL = 'schedule'

/** Outil intégré qui annule un réveil prévu. */
export const CANCEL_WAKEUP_TOOL = 'cancel_wakeup'

/** Outils que le Harness ajoute lui-même au journal : le modèle ne les a jamais appelés. */
export const HARNESS_TOOLS: readonly string[] = [APPROVAL_TOOL, ELICIT_TOOL]

/** Appel du canal utilisateur en attente de la personne. */
export type Question = ToolCall
