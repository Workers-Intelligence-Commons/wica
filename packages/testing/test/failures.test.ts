import { createHarness, MemoryStore } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

describe('host failures', () => {
  // Without this report, `run` would wait forever for the end of a turn that never comes.
  it('a Store failure during a tool ends run with the error', async () => {
    class BrokenStore extends MemoryStore {
      override async claimToolCall(): Promise<'claimed'> {
        throw new Error('store failure during a tool')
      }
    }
    const harness = createHarness({
      store: new BrokenStore(),
      authorize: () => 'allow',
      tools: [
        {
          spec: { name: 't', description: 'tool', inputSchema: {}, channel: 'environment' },
          run: async () => [],
        },
      ],
      model: scriptedModel(() => ({
        parts: [{ type: 'tool_call', callId: 'k', tool: 't', input: {} }],
      })),
    })
    const events: string[] = []
    for await (const event of harness.run('x', { conversationId: 'c' })) {
      events.push(event.type === 'error' ? `error:${event.message}` : event.type)
    }
    expect(events).toContain('error:store failure during a tool')
    expect(events.at(-1)).toBe('done')
  })
})
