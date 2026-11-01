import { allowAll, createHarness, MemoryStore, type ModelAdapter } from '@wica/runtime'
import { memoryFiles } from '@wica/testing'
import { loremModel } from '@wica/testing/lorem'
import { describe, expect, it } from 'vite-plus/test'

import { measuredModel } from '../src/server/model-calls.ts'
import type { ModelCallRow } from '../src/shared/rows.ts'

/** Lorem, reporting the tokens a provider would give for each response. */
const withUsage =
  (inner: ModelAdapter) =>
  (
    onUsage: (usage: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }) => void,
  ): ModelAdapter => ({
    async *stream(request, signal) {
      for await (const chunk of inner.stream(request, signal)) {
        if (chunk.type === 'done') onUsage({ input: 100, output: 20, cacheRead: 50, cacheWrite: 0 })
        yield chunk
      }
    },
  })

describe('measured model calls', () => {
  // Each response must show the model and measures of the call that wrote it, and only that call.
  it('records each completed call of a turn with the items it wrote, its timings and its tokens', async () => {
    const store = new MemoryStore()
    const recorded: ModelCallRow[] = []
    let clock = 0
    const model = measuredModel({
      conversationId: 'm1',
      model: 'lorem:lorem-tools',
      modelName: 'Lorem ipsum, a tool call each turn',
      adapter: withUsage(loremModel('lorem-tools', { delayMs: 0 })),
      store,
      calls: { record: async (call) => void recorded.push(call) },
      now: () => (clock += 10),
    })
    const harness = createHarness({
      model,
      store,
      tools: [memoryFiles({ 'Lorem ipsum dolor sit amet.': 'content' })],
      authorize: allowAll,
    })
    for await (const _ of harness.run('Hello', { conversationId: 'm1' })) void _

    const items = (await store.load('m1', 0)).items
    const ids = (kind: string) => items.filter((i) => i.kind === kind).map((i) => i.id)
    const [firstText, secondText] = ids('assistant_text')
    const [toolCall] = ids('tool_call')
    // One call answers with a text and a tool call; the next one answers the tool's result.
    expect(recorded.map((c) => c.item_ids)).toEqual([[firstText, toolCall], [secondText]])
    for (const call of recorded) {
      expect(call).toMatchObject({
        conversation_id: 'm1',
        model: 'lorem:lorem-tools',
        model_name: 'Lorem ipsum, a tool call each turn',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 50,
        cache_write_tokens: 0,
      })
      // The clock advances 10 ms a reading: the first token comes before the end.
      expect(call.first_token_ms).toBe(10)
      expect(call.duration_ms).toBeGreaterThan(10)
    }
    expect(new Set(recorded.map((c) => c.id)).size).toBe(2)
  })

  // A provider that reports no tokens must not get invented counts.
  it('keeps the tokens empty when the provider reports none', async () => {
    const store = new MemoryStore()
    const recorded: ModelCallRow[] = []
    const harness = createHarness({
      model: measuredModel({
        conversationId: 'm2',
        model: null,
        modelName: 'wpt',
        adapter: () => loremModel('lorem', { delayMs: 0 }),
        store,
        calls: { record: async (call) => void recorded.push(call) },
      }),
      store,
    })
    for await (const _ of harness.run('Hello', { conversationId: 'm2' })) void _
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
    })
    expect(recorded[0]?.first_token_ms).not.toBeNull()
  })

  // The runtime may append to the request an item it never writes, without a `seq`.
  it('links the response even when the request path ends with an item that is not written', async () => {
    const store = new MemoryStore()
    const recorded: ModelCallRow[] = []
    const measured = measuredModel({
      conversationId: 'm3',
      model: null,
      modelName: 'wpt',
      adapter: () => loremModel('lorem', { delayMs: 0 }),
      store,
      calls: { record: async (call) => void recorded.push(call) },
    })
    const harness = createHarness({
      model: {
        stream: (request, signal) => {
          const first = request.path[0]
          if (!first) throw new Error('empty path')
          const unwritten = { ...first, id: 'unwritten', seq: undefined as unknown as number }
          return measured.stream({ ...request, path: [...request.path, unwritten] }, signal)
        },
      },
      store,
    })
    for await (const _ of harness.run('Hello', { conversationId: 'm3' })) void _
    const texts = (await store.load('m3', 0)).items.filter((i) => i.kind === 'assistant_text')
    expect(texts).toHaveLength(1)
    expect(recorded.map((c) => c.item_ids)).toEqual([texts.map((i) => i.id)])
  })
})
