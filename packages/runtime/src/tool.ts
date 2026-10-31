// Tools and authorization.

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
  /** Progress message to the client, never to the model. */
  progress: (message: string) => void
  /** Active path, read-only. */
  path: readonly Item[]
  /**
   * Asks the person a question during the tool (information request of an MCP server) and returns
   * their answer. The question goes through the user channel; the answer counts as their speech.
   */
  ask: (input: unknown) => Promise<unknown>
}

export type Tool = {
  spec: ToolSpec
  /** Absent: the tool is only declared and runs elsewhere. */
  run?: (input: unknown, ctx: ToolContext) => Promise<Part[]>
}

type Issue = { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }

/** Schema conforming to Standard Schema and to Standard JSON Schema (Zod, Valibot, ArkType…). */
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

/** A tool: a name, a description, a schema and a function. */
export function defineTool<O>(
  definition: ToolDefinition<O> & { input: StandardToolSchema<unknown, O> },
): Tool
/** Raw JSON Schema variant (MCP tools): validation is up to whoever runs it. */
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
          // A validation failure becomes an error result for the model, never an exception.
          throw new ToolInputError(
            `Invalid arguments: ${result.issues.map((i) => i.message).join('; ')}`,
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
  /** Trust of the input that triggered the turn. */
  trust: Trust
  /** True when a client is attached to the conversation. */
  attached: boolean
}

export type AuthorizeCall = ToolCall & { annotations: ToolAnnotations }

export type Authorize = (
  call: AuthorizeCall,
  ctx: AuthorizeContext,
) => AuthorizeDecision | Promise<AuthorizeDecision>

/** Everything is allowed: the choice is visible in the host code. */
export const allowAll: Authorize = () => 'allow'

/** Only read-only tools pass. */
export const readOnlyOnly: Authorize = (call) =>
  call.annotations.readOnlyHint ? 'allow' : { deny: 'Only read-only tools are allowed.' }

/**
 * MCP default values: without an annotation, a tool is destructive and touches the open world; a
 * read-only tool is never destructive.
 */
export const isDestructive = (a: ToolAnnotations) =>
  a.readOnlyHint !== true && a.destructiveHint !== false
export const isOpenWorld = (a: ToolAnnotations) => a.openWorldHint !== false

/**
 * Agent without a person: whatever is destructive or touches the open world waits for the
 * approval of the designated approver; the rest passes. With `approvalTimeoutMs`, silence counts
 * as a refusal.
 */
export const unattended: Authorize = (call) =>
  isDestructive(call.annotations) || isOpenWorld(call.annotations)
    ? { ask: `Allow ${call.tool}?` }
    : 'allow'

/**
 * Wake-up tools, provided by the Harness: the core runs them by writing the wake-up into the
 * journal, and the host wakes the conversation at the stated time through its `Scheduler`.
 */
export const scheduleTools: Tool[] = [
  {
    spec: {
      name: SCHEDULE_TOOL,
      description:
        'Schedules a wake-up of this conversation, at a date (at) or after a delay (inSeconds), once or every `every`. At the wake-up, you receive payload and you resume on your own.',
      inputSchema: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'ISO 8601 date.' },
          inSeconds: { type: 'number', minimum: 0, description: 'Delay in seconds.' },
          every: {
            type: 'string',
            description:
              'Recurrence, ISO 8601 duration in days, hours, minutes or seconds (PT15M, P1D).',
          },
          payload: { description: 'What you want to remind yourself of at the wake-up.' },
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
      description: 'Cancels a scheduled wake-up, designated by its identifier.',
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
