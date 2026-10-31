// Conversion between the journal and the Open Responses specification, version 2026-04-24
// (https://www.openresponses.org/specification): active path to request body, stream events to
// `Delta` and `AssistantMessage`. No state is kept on the provider side: each request carries
// `store: false` and the whole path, never `previous_response_id`.

import type {
  AssistantMessage,
  AssistantPart,
  Delta,
  ModelRequest,
  Part,
  ToolSpec,
} from '@wica/core'

import { toTranscript, type TranscriptEntry } from './transcript.ts'

type InputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; file_url: string }

export type InputItem =
  | { type: 'message'; role: 'user' | 'developer'; content: InputContent[] }
  | { type: 'message'; role: 'assistant'; content: { type: 'output_text'; text: string }[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: InputContent[] }
  | {
      type: 'reasoning'
      summary: { type: 'summary_text'; text: string }[]
      encrypted_content?: string
    }

export type FunctionTool = {
  type: 'function'
  name: string
  description: string
  parameters: unknown
  strict: false
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export type OpenResponsesRequest = {
  model: string
  input: InputItem[]
  instructions?: string
  tools?: FunctionTool[]
  stream: true
  store: false
  include: ['reasoning.encrypted_content']
  reasoning?: { effort?: ReasoningEffort; summary?: 'concise' | 'detailed' | 'auto' }
  max_output_tokens?: number
  temperature?: number
}

export type RequestOptions = {
  model: string
  /**
   * Name of the provider written into the opaque reasoning data: it is sent back only to the same
   * provider (journal rule).
   */
  provider: string
  reasoning?: OpenResponsesRequest['reasoning']
  maxOutputTokens?: number
  temperature?: number
}

/** Opaque content of a reasoning item, kept as it is in the journal. */
export type ReasoningOpaque = {
  encrypted_content?: string
  summary?: { type: 'summary_text'; text: string }[]
}

/** A tool name that the specification refuses. */
export class ToolNameError extends Error {
  override name = 'ToolNameError'
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const content = (parts: Part[]): InputContent[] =>
  parts.map((p) =>
    p.type === 'text'
      ? { type: 'input_text', text: p.text }
      : p.mediaType.startsWith('image/')
        ? { type: 'input_image', image_url: p.uri }
        : { type: 'input_file', file_url: p.uri },
  )

function tool(spec: ToolSpec): FunctionTool {
  if (!TOOL_NAME.test(spec.name)) {
    throw new ToolNameError(
      `Tool name refused by Open Responses: "${spec.name}" (letters, digits, _ and -, 64 at most).`,
    )
  }
  return {
    type: 'function',
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    strict: false,
  }
}

function inputItem(entry: TranscriptEntry, provider: string): InputItem | undefined {
  switch (entry.type) {
    case 'user':
    case 'developer':
      return {
        type: 'message',
        role: entry.type,
        content:
          entry.type === 'user' ? content(entry.parts) : [{ type: 'input_text', text: entry.text }],
      }
    case 'assistant_text':
      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: entry.text }],
      }
    case 'reasoning': {
      const opaque = entry.opaque?.provider === provider ? entry.opaque.data : undefined
      const data = opaque as ReasoningOpaque | undefined
      if (data?.encrypted_content === undefined && (data?.summary?.length ?? 0) === 0) return
      return {
        type: 'reasoning',
        summary: data?.summary ?? [],
        ...(data?.encrypted_content !== undefined
          ? { encrypted_content: data.encrypted_content }
          : {}),
      }
    }
    case 'tool_call':
      return {
        type: 'function_call',
        call_id: entry.callId,
        name: entry.tool,
        arguments: typeof entry.input === 'string' ? entry.input : JSON.stringify(entry.input),
      }
    case 'tool_result':
      return { type: 'function_call_output', call_id: entry.callId, output: content(entry.output) }
  }
}

/** Active path to the body of an Open Responses request. */
export function toOpenResponsesRequest(
  request: ModelRequest,
  options: RequestOptions,
): OpenResponsesRequest {
  const input = toTranscript(request).flatMap((entry) => {
    const item = inputItem(entry, options.provider)
    return item ? [item] : []
  })
  return {
    model: options.model,
    input,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(request.tools.length > 0 && !request.summarize ? { tools: request.tools.map(tool) } : {}),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.maxOutputTokens !== undefined
      ? { max_output_tokens: options.maxOutputTokens }
      : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  }
}

export type DecodedChunk =
  | Delta
  | { type: 'done'; message: AssistantMessage; incomplete?: string }
  | { type: 'failed'; code: string | null; message: string }

type OutputItem = {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: { type?: string; text?: string; refusal?: string }[]
  summary?: { type?: string; text?: string }[]
  encrypted_content?: string
}

function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    // Arguments that are not JSON stay as text: the tool validation then returns an error result
    // to the model.
    return raw
  }
}

function toPart(item: OutputItem, provider: string): AssistantPart | undefined {
  switch (item.type) {
    case 'message': {
      const t = (item.content ?? [])
        .map((c) => (c.type === 'refusal' ? (c.refusal ?? '') : (c.text ?? '')))
        .join('')
      return { type: 'text', text: t }
    }
    case 'reasoning': {
      const raw = (item.content ?? []).map((c) => c.text ?? '').join('')
      const summary = (item.summary ?? []).map((s) => ({
        type: 'summary_text' as const,
        text: s.text ?? '',
      }))
      const shown = raw !== '' ? raw : summary.map((s) => s.text).join('\n\n')
      const opaque: ReasoningOpaque = {
        ...(item.encrypted_content !== undefined
          ? { encrypted_content: item.encrypted_content }
          : {}),
        ...(summary.length > 0 ? { summary } : {}),
      }
      return {
        type: 'reasoning',
        ...(shown !== '' ? { text: shown } : {}),
        ...(Object.keys(opaque).length > 0 ? { opaque: { provider, data: opaque } } : {}),
      }
    }
    case 'function_call':
      return {
        type: 'tool_call',
        callId: item.call_id ?? item.id ?? '',
        tool: item.name ?? '',
        input: parseArguments(item.arguments),
      }
    default:
      // Items specific to a provider (prefixed by its name): ignored, as the spec requires.
      return undefined
  }
}

/** Decoder of the stream events of a response; each event returns zero or more chunks. */
export function createOpenResponsesDecoder(options: { provider: string }) {
  const items = new Map<number, OutputItem>()
  let finished = false

  const message = (output: OutputItem[] | undefined): AssistantMessage => {
    const list = output ?? [...items.entries()].sort(([a], [b]) => a - b).map(([, i]) => i)
    return {
      parts: list.flatMap((i) => {
        const part = toPart(i, options.provider)
        return part ? [part] : []
      }),
    }
  }

  return {
    get finished() {
      return finished
    },
    push(event: unknown): DecodedChunk[] {
      const e = event as {
        type?: string
        delta?: string
        output_index?: number
        item?: OutputItem | null
        response?: {
          output?: OutputItem[]
          error?: { code?: string | null; message?: string } | null
          incomplete_details?: { reason?: string } | null
        }
        error?: { code?: string | null; message?: string }
      }
      switch (e.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          return e.delta ? [{ type: 'text', text: e.delta }] : []
        case 'response.reasoning.delta':
        case 'response.reasoning_summary_text.delta':
          return e.delta ? [{ type: 'reasoning', text: e.delta }] : []
        case 'response.output_item.added':
        case 'response.output_item.done':
          if (e.item && e.output_index !== undefined) items.set(e.output_index, e.item)
          return []
        case 'response.completed':
          finished = true
          return [{ type: 'done', message: message(e.response?.output) }]
        case 'response.incomplete':
          finished = true
          return [
            {
              type: 'done',
              message: message(e.response?.output),
              incomplete: e.response?.incomplete_details?.reason ?? 'unknown',
            },
          ]
        case 'response.failed':
          finished = true
          return [
            {
              type: 'failed',
              code: e.response?.error?.code ?? null,
              message: e.response?.error?.message ?? 'The response failed.',
            },
          ]
        case 'error':
          finished = true
          return [
            {
              type: 'failed',
              code: e.error?.code ?? null,
              message: e.error?.message ?? 'Provider error.',
            },
          ]
        default:
          return []
      }
    },
  }
}
