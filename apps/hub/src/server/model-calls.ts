// Measures of the model calls, taken by the hub around the adapter: the Harness does not know
// which model answers. Once the runtime has written the response, the call is kept with the
// items it wrote: the turn holds the conversation alone, so the items of a model kind written
// since the call started are its own.

import type { ModelUsage } from '@wica/model-pi'
import type { ModelAdapter, Store } from '@wica/runtime'

import type { ModelCallRow } from '../shared/rows.ts'
import type { ModelCalls } from './data.ts'

/** Kinds of the items only a model response writes. */
const RESPONSE_KINDS = new Set(['assistant_text', 'reasoning', 'tool_call'])

export type MeasuredModelOptions = {
  conversationId: string
  /** As `conversations.model`. */
  model: string | null
  modelName: string
  /** Makes the adapter, given where it reports the tokens of each response. */
  adapter: (onUsage: (usage: ModelUsage) => void) => ModelAdapter
  store: Pick<Store, 'load'>
  calls: ModelCalls
  now?: () => number
  newId?: () => string
}

/** The adapter, measured: each completed call is recorded with its timings and its tokens. */
export function measuredModel(options: MeasuredModelOptions): ModelAdapter {
  const now = options.now ?? (() => performance.now())
  const newId = options.newId ?? (() => crypto.randomUUID())
  // The calls of one Harness follow one another: the usage reported belongs to the current one.
  let usage: ModelUsage | null = null
  const inner = options.adapter((reported) => (usage = reported))

  /** Highest `seq` of the journal: what the call writes comes after it. */
  const lastSeq = async (fromSeq: number) => {
    const { items } = await options.store.load(options.conversationId, fromSeq)
    return items.reduce((max, i) => Math.max(max, i.seq), fromSeq)
  }

  return {
    async *stream(request, signal) {
      // A summary writes no response, only the `compacted` event: nothing to show it on.
      if (request.summarize) {
        yield* inner.stream(request, signal)
        return
      }
      // The path may end with items the runtime adds without writing them: they have no `seq`.
      const written = request.path.flatMap((i) => (typeof i.seq === 'number' ? [i.seq] : []))
      const startSeq = await lastSeq(Math.max(0, ...written))
      usage = null
      const startedAt = new Date().toISOString()
      const start = now()
      let firstToken: number | null = null
      for await (const chunk of inner.stream(request, signal)) {
        if (chunk.type !== 'done') {
          firstToken ??= now() - start
          yield chunk
          continue
        }
        const duration = now() - start
        const reported = usage as ModelUsage | null
        // The runtime writes the response before asking for the next chunk.
        yield chunk
        try {
          const { items } = await options.store.load(options.conversationId, startSeq)
          const call: ModelCallRow = {
            conversation_id: options.conversationId,
            id: newId(),
            item_ids: items.filter((i) => RESPONSE_KINDS.has(i.kind)).map((i) => i.id),
            model: options.model,
            model_name: options.modelName,
            started_at: startedAt,
            first_token_ms: firstToken === null ? null : Math.round(firstToken),
            duration_ms: Math.round(duration),
            input_tokens: reported?.input ?? null,
            output_tokens: reported?.output ?? null,
            cache_read_tokens: reported?.cacheRead ?? null,
            cache_write_tokens: reported?.cacheWrite ?? null,
            reasoning: request.reasoning ?? null,
          }
          await options.calls.record(call)
        } catch (error) {
          // A measure that cannot be kept does not fail the response.
          console.error(`model call not recorded in ${options.conversationId}: ${String(error)}`)
        }
      }
    },
  }
}
