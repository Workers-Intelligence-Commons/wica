// Model adapter for hosted providers, on top of the pi-ai library and of it alone. The path
// rendering comes from `codecs`; this package translates it into pi-ai messages, and the pi-ai
// stream into `Delta`s.

import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  TSchema,
} from '@earendil-works/pi-ai'
import { toTranscript, type TranscriptEntry } from '@wica/codecs'
import type { AssistantMessage, AssistantPart, ModelRequest, Part, ToolSpec } from '@wica/core'
import type { ModelAdapter, ModelChunk } from '@wica/runtime'

export type PiModelOptions = {
  /** Collection of pi-ai models, created and authenticated by the host. */
  models: Models
  /** Provider and model in the pi-ai sense, for example `anthropic` and `claude-sonnet-5-5`. */
  provider: string
  model: string
  reasoning?: ThinkingLevel
  /** pi-ai request options (key, headers, retries, duration); neither signal nor reasoning. */
  request?: Omit<ModelsSimpleStreamOptions, 'signal' | 'reasoning'>
  /**
   * Called before the first request of this adapter that goes through a subscription (OAuth
   * login), so that the host warns the person; the host keeps track of a warning already given.
   */
  onFirstSubscriptionUse?: (provider: string) => void | Promise<void>
}

/** Failure of the provider, returned by pi-ai. */
export class ModelError extends Error {
  override name = 'ModelError'
}

/**
 * Opaque data of a response: a thinking block, or the signatures that pi-ai attaches to texts (in
 * their order) and to calls (by identifier). They are valid only for the model that produced
 * them.
 */
export type PiOpaque =
  | { thinking: ThinkingContent }
  | { texts: (string | null)[]; toolCalls: Record<string, ToolCallExtra> }

type ToolCallExtra = Omit<ToolCall, 'type' | 'id' | 'name' | 'arguments' | 'argumentsError'>

type Target = Pick<Model<Api>, 'api' | 'provider' | 'id'>

/** Provider written into the opaque data: the exact API, provider and model. */
export const opaqueProvider = (model: Target) => `pi:${model.api}:${model.provider}:${model.id}`

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s

/** An image in `data:` leaves as an image; another file, which pi-ai cannot read, as a mention. */
function content(parts: Part[]): (TextContent | ImageContent)[] {
  return parts.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    const data = DATA_URI.exec(p.uri)
    if (data && p.mediaType.startsWith('image/')) {
      return { type: 'image', data: data[2] ?? '', mimeType: data[1] ?? p.mediaType }
    }
    return { type: 'text', text: `[File ${p.mediaType}: ${p.uri}]` }
  })
}

const tool = (spec: ToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  // TypeBox describes its schemas in ordinary JSON Schema, which pi-ai sends as it is.
  parameters: spec.inputSchema as TSchema,
})

const ZERO_USAGE: PiAssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

type AssistantEntry = Extract<
  TranscriptEntry,
  { type: 'assistant_text' | 'reasoning' | 'tool_call' }
>

/** A sequence of model entries to a pi-ai message, with only the opaque data of the model. */
function assistantMessage(entries: AssistantEntry[], model: Target): PiAssistantMessage {
  const own = opaqueProvider(model)
  const blocks: PiAssistantMessage['content'] = []
  let signatures: Extract<PiOpaque, { texts: unknown }> | undefined
  for (const entry of entries) {
    if (entry.type === 'assistant_text') blocks.push({ type: 'text', text: entry.text })
    else if (entry.type === 'tool_call') {
      blocks.push({
        type: 'toolCall',
        id: entry.callId,
        name: entry.tool,
        arguments:
          typeof entry.input === 'object' && entry.input !== null && !Array.isArray(entry.input)
            ? (entry.input as ToolCall['arguments'])
            : {},
      })
    } else if (entry.opaque?.provider === own) {
      const data = entry.opaque.data as PiOpaque
      if ('thinking' in data) blocks.push(data.thinking)
      else signatures = data
    }
  }
  if (signatures) {
    let text = 0
    for (const block of blocks) {
      if (block.type === 'text') {
        const signature = signatures.texts[text++]
        if (signature) block.textSignature = signature
      } else if (block.type === 'toolCall') {
        Object.assign(block, signatures.toolCalls[block.id])
      }
    }
  }
  return {
    role: 'assistant',
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: blocks.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/**
 * Active path to the pi-ai context. The Harness instructions placed in the conversation (summary,
 * branch resume, summary request) leave as user messages: not every provider accepts a system
 * instruction in the middle, and pi-ai would otherwise fold them into the system prompt, far
 * from their place.
 */
export function toPiContext(request: ModelRequest, model: Target): Context {
  const messages: Message[] = []
  let pending: AssistantEntry[] = []
  const flush = () => {
    if (pending.length > 0) messages.push(assistantMessage(pending, model))
    pending = []
  }
  for (const entry of toTranscript(request)) {
    switch (entry.type) {
      case 'assistant_text':
      case 'reasoning':
      case 'tool_call':
        pending.push(entry)
        break
      case 'user':
        flush()
        messages.push({ role: 'user', content: content(entry.parts), timestamp: 0 })
        break
      case 'developer':
        flush()
        messages.push({ role: 'user', content: entry.text, timestamp: 0 })
        break
      case 'tool_result':
        flush()
        messages.push({
          role: 'toolResult',
          toolCallId: entry.callId,
          toolName: entry.tool,
          content: content(entry.output),
          isError: entry.isError,
          timestamp: 0,
        })
        break
    }
  }
  flush()
  return {
    ...(request.instructions ? { systemPrompt: request.instructions } : {}),
    messages,
    ...(request.tools.length > 0 && !request.summarize ? { tools: request.tools.map(tool) } : {}),
  }
}

/** Final pi-ai message to the Harness one; the signatures go into a reasoning part. */
export function fromPiMessage(message: PiAssistantMessage, model: Target): AssistantMessage {
  const provider = opaqueProvider(model)
  const parts: AssistantPart[] = []
  const texts: (string | null)[] = []
  const toolCalls: Record<string, ToolCallExtra> = {}
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
      texts.push(block.textSignature ?? null)
    } else if (block.type === 'thinking') {
      parts.push({
        type: 'reasoning',
        ...(block.thinking !== '' && !block.redacted ? { text: block.thinking } : {}),
        opaque: { provider, data: { thinking: block } satisfies PiOpaque },
      })
    } else {
      const { type: _type, id, name, arguments: input, argumentsError, ...extra } = block
      // Arguments that are not a JSON object stay as text: the tool validation then returns an
      // error result to the model.
      parts.push({ type: 'tool_call', callId: id, tool: name, input: argumentsError ?? input })
      if (Object.keys(extra).length > 0) toolCalls[id] = extra
    }
  }
  if (texts.some((t) => t !== null) || Object.keys(toolCalls).length > 0) {
    parts.push({
      type: 'reasoning',
      opaque: { provider, data: { texts, toolCalls } satisfies PiOpaque },
    })
  }
  return { parts }
}

export function piModel(options: PiModelOptions): ModelAdapter {
  let warned = false

  const resolve = async () => {
    const model = options.models.getModel(options.provider, options.model)
    if (!model) {
      throw new ModelError(`Model unknown to pi-ai: ${options.provider}/${options.model}.`)
    }
    if (options.onFirstSubscriptionUse && !warned) {
      const auth = await options.models.checkAuth(options.provider)
      if (auth?.type === 'oauth') {
        warned = true
        await options.onFirstSubscriptionUse(options.provider)
      }
    }
    return model
  }

  return {
    async *stream(request, signal): AsyncIterable<ModelChunk> {
      const model = await resolve()
      const events = options.models.streamSimple(model, toPiContext(request, model), {
        ...options.request,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        signal,
      })
      for await (const event of events) {
        switch (event.type) {
          case 'text_delta':
            if (event.delta !== '') yield { type: 'text', text: event.delta }
            break
          case 'thinking_delta':
            if (event.delta !== '') yield { type: 'reasoning', text: event.delta }
            break
          case 'done':
            yield { type: 'done', message: fromPiMessage(event.message, model) }
            return
          case 'error':
            throw new ModelError(
              event.error.errorMessage ??
                (event.reason === 'aborted' ? 'Model request cancelled.' : 'Provider error.'),
            )
        }
      }
      throw new ModelError('The model stream stopped without a final response.')
    },
  }
}
