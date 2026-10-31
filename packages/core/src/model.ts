import type { Item } from './journal.ts'

export type JSONSchema = Record<string, unknown> | boolean

/** Vocabulary of MCP tool annotations. */
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
  /** Identifier of the item the model answers. */
  trigger: string
  /** Active path, from the root to the head. */
  path: Item[]
  tools: ToolSpec[]
  /** Host instructions for the model, outside the journal. */
  instructions?: string
  /**
   * Summary request: the model summarizes `path` without tools, and its text becomes the
   * `compacted` event of this range instead of a response.
   */
  summarize?: { from: string; to: string }
}

export type ToolCall = {
  callId: string
  tool: string
  input: unknown
  channel: 'environment' | 'user'
  /** True when the person has already granted this call: the host does not ask `authorize` again. */
  approved?: boolean
}

/** User channel tool that carries an approval request in the journal. */
export const APPROVAL_TOOL = 'approve'

/** `callId` of the approval request linked to a tool call. */
export const approvalCallId = (callId: string) => `approve:${callId}`

/**
 * User channel tool that carries a question asked by a running tool, for example the information
 * request of an MCP server. Its answer goes back to the waiting tool.
 */
export const ELICIT_TOOL = 'elicit'

/** `callId` of the question `n` asked during the call `callId`. */
export const elicitCallId = (callId: string, n: number) => `elicit:${callId}:${n}`

/** Built-in tool that schedules a wake-up of the conversation (once or recurring). */
export const SCHEDULE_TOOL = 'schedule'

/** Built-in tool that cancels a scheduled wake-up. */
export const CANCEL_WAKEUP_TOOL = 'cancel_wakeup'

/** Tools the Harness adds to the journal itself: the model never called them. */
export const HARNESS_TOOLS: readonly string[] = [APPROVAL_TOOL, ELICIT_TOOL]

/** User channel call waiting for the person. */
export type Question = ToolCall
