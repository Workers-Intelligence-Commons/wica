import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Models,
} from '@earendil-works/pi-ai'
import type { Item, ModelRequest } from '@wica/core'
import { type ModelScenario, modelAdapterConformance } from '@wica/testing'
import { describe, expect, it } from 'vite-plus/test'

import { fromPiMessage, piModel, toPiContext } from '../src/index.ts'

function faux(scenario: ModelScenario) {
  const handle = fauxProvider({ tokensPerSecond: scenario === 'endless' ? 20 : 100_000 })
  const models = createModels()
  models.setProvider(handle.provider)
  handle.setResponses([
    {
      text: fauxAssistantMessage('Hello.'),
      tool_call: fauxAssistantMessage(fauxToolCall('read_file', { path: 'a.txt' }, { id: 'k1' }), {
        stopReason: 'toolUse',
      }),
      failure: () => {
        throw new Error('unknown model')
      },
      endless: fauxAssistantMessage('word '.repeat(10_000)),
    }[scenario],
  ])
  return { models, model: handle.getModel() }
}

modelAdapterConformance('model-pi', (scenario) => {
  const { models, model } = faux(scenario)
  return piModel({ models, provider: model.provider, model: model.id })
})

const at = '2026-10-30T10:00:00.000Z'
const item = (seq: number, parentId: string | null, body: Partial<Item>): Item =>
  ({ id: `i${seq}`, parentId, seq, at, status: 'done', ...body }) as Item

const anthropic = { api: 'anthropic-messages', provider: 'anthropic', id: 'claude-a' }

describe('model-pi', () => {
  it('returns its signatures and its thinking to the same model, never to another', () => {
    const answer = fromPiMessage(
      {
        ...fauxAssistantMessage([
          { ...fauxThinking('Reading the file.'), thinkingSignature: 'sig-r' },
          { ...fauxText('Looking.'), textSignature: 'sig-t' },
          {
            ...fauxToolCall('read_file', { path: 'a.txt' }, { id: 'k1' }),
            thoughtSignature: 'sig-c',
          },
        ]),
      },
      anthropic,
    )
    // The parts become journal items, as the core does.
    const path: Item[] = [
      item(1, null, { kind: 'user_message', parts: [{ type: 'text', text: 'Read a.txt' }] }),
    ]
    for (const part of answer.parts) {
      const parent = path.at(-1)?.id ?? null
      const seq = path.length + 1
      if (part.type === 'text') {
        path.push(item(seq, parent, { kind: 'assistant_text', text: part.text, audience: 'user' }))
      } else if (part.type === 'reasoning') {
        path.push(item(seq, parent, { kind: 'reasoning', ...part }))
      } else {
        path.push(item(seq, parent, { kind: 'tool_call', ...part, channel: 'environment' }))
      }
    }
    path.push(
      item(path.length + 1, path.at(-1)?.id ?? null, {
        kind: 'tool_result',
        callId: 'k1',
        output: [{ type: 'text', text: 'content' }],
      }),
    )
    const request: ModelRequest = { trigger: 'x', path, tools: [] }

    const same = toPiContext(request, anthropic).messages
    expect(same.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult'])
    expect(same[1]).toMatchObject({
      content: [
        { type: 'thinking', thinking: 'Reading the file.', thinkingSignature: 'sig-r' },
        { type: 'text', text: 'Looking.', textSignature: 'sig-t' },
        { type: 'toolCall', id: 'k1', arguments: { path: 'a.txt' }, thoughtSignature: 'sig-c' },
      ],
    })
    expect(same[2]).toMatchObject({ toolCallId: 'k1', toolName: 'read_file', isError: false })

    const other = toPiContext(request, { ...anthropic, id: 'claude-b' }).messages[1]
    expect(other).toMatchObject({ role: 'assistant', model: 'claude-b' })
    expect(other?.role === 'assistant' && other.content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'toolCall', id: 'k1', name: 'read_file', arguments: { path: 'a.txt' } },
    ])
  })

  it('asks for a summary without tools, with the instruction as the last message', () => {
    const request: ModelRequest = {
      trigger: 'i1',
      path: [item(1, null, { kind: 'user_message', parts: [{ type: 'text', text: 'Hello' }] })],
      tools: [
        {
          name: 'read_file',
          description: 'Reads.',
          inputSchema: { type: 'object' },
          channel: 'environment',
        },
      ],
      summarize: { from: 'i1', to: 'i1' },
    }
    const context = toPiContext(request, anthropic)
    expect(context.tools).toBeUndefined()
    expect(context.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Summarize'),
    })
  })

  it('warns the host once, at the first request that goes through a subscription', async () => {
    const { models, model } = faux('text')
    const subscribed: Models = Object.assign(Object.create(models) as Models, {
      checkAuth: async () => ({ type: 'oauth' as const }),
    })
    const warnings: string[] = []
    const adapter = piModel({
      models: subscribed,
      provider: model.provider,
      model: model.id,
      onFirstSubscriptionUse: (provider) => void warnings.push(provider),
    })
    const request: ModelRequest = {
      trigger: 'i1',
      path: [item(1, null, { kind: 'user_message', parts: [{ type: 'text', text: 'Hello' }] })],
      tools: [],
    }
    for await (const _ of adapter.stream(request, new AbortController().signal));
    // The second request no longer warns; pi-ai has no more responses and fails.
    await expect(
      (async () => {
        for await (const _ of adapter.stream(request, new AbortController().signal));
      })(),
    ).rejects.toThrow()
    expect(warnings).toEqual([model.provider])
  })
})
