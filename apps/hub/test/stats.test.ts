import { describe, expect, it } from 'vite-plus/test'

import { callDetails } from '../src/client/stats.ts'
import type { ModelCallRow } from '../src/shared/rows.ts'

const call = (over: Partial<ModelCallRow>): ModelCallRow => ({
  conversation_id: 'c1',
  id: 'k1',
  item_ids: ['a'],
  model: 'pi:anthropic/claude-a',
  model_name: 'Claude A',
  started_at: '2026-11-01T10:00:00.000Z',
  first_token_ms: 400,
  duration_ms: 2_400,
  input_tokens: 200,
  output_tokens: 100,
  cache_read_tokens: 1_000,
  cache_write_tokens: 0,
  reasoning: 'high',
  ...over,
})

describe('the details line of a response', () => {
  // Speed counts the writing only: 100 tokens over the 2 s after the first token.
  it('says the model, its reasoning level, its speed and every token it read, cached ones included', () => {
    expect(callDetails(call({}))).toEqual([
      'Claude A',
      'high reasoning',
      '400 ms to first token',
      '50 tokens/s',
      '2.4 s in all',
      '1,200 in, 1,000 cached',
      '100 out',
    ])
  })

  // The person chose to see only what was measured: no token figure is made up.
  it('leaves out the tokens and the speed when the provider reports no tokens', () => {
    const details = callDetails(
      call({
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        reasoning: null,
      }),
    )
    expect(details).toEqual(['Claude A', '400 ms to first token', '2.4 s in all'])
  })
})
