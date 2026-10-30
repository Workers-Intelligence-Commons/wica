import { createHarness, MemoryStore } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

describe('pannes de l’hôte', () => {
  // Sans ce rapport, `run` attendrait sans fin une fin de tour qui n'arrive jamais.
  it('une panne du Store pendant un outil termine run avec l’erreur', async () => {
    class BrokenStore extends MemoryStore {
      override async claimToolCall(): Promise<'claimed'> {
        throw new Error('panne du store pendant un outil')
      }
    }
    const harness = createHarness({
      store: new BrokenStore(),
      authorize: () => 'allow',
      tools: [
        {
          spec: { name: 't', description: 'outil', inputSchema: {}, channel: 'environment' },
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
    expect(events).toContain('error:panne du store pendant un outil')
    expect(events.at(-1)).toBe('done')
  })
})
