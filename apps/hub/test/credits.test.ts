import { describe, expect, it } from 'vite-plus/test'

import {
  allowanceAt,
  type CreditPrices,
  creditsOf,
  UnpricedModelError,
  weekStart,
} from '../src/server/credits.ts'

const prices: CreditPrices = {
  userMessage: 1,
  models: { '': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 4 } },
  tools: { web_search: 5 },
  otherTools: 1,
  reasoning: { high: 2 },
}

describe('credits of a request', () => {
  // Each kind of request has its own price: a message, a tool call by name, and a model call by
  // the tokens it used at its model's prices, multiplied by its reasoning level.
  it('prices each kind of request on its own terms', () => {
    expect(creditsOf({ kind: 'user_message' }, prices)).toBe(1)
    expect(creditsOf({ kind: 'tool_call', tool: 'web_search' }, prices)).toBe(5)
    expect(creditsOf({ kind: 'tool_call', tool: 'read_file' }, prices)).toBe(1)
    const call = {
      kind: 'model_call' as const,
      model: null,
      reasoning: null,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 0,
    }
    // 1M × 2 + 0.5M × 8 + 2M × 0.5 = 7 credits.
    expect(creditsOf(call, prices)).toBe(7)
    expect(creditsOf({ ...call, reasoning: 'high' }, prices)).toBe(14)
    expect(creditsOf({ ...call, reasoning: 'low' }, prices)).toBe(7)
  })

  // A model without a price never costs a made-up amount.
  it('refuses to price a model it has no price for', () => {
    expect(() =>
      creditsOf(
        {
          kind: 'model_call',
          model: 'pi:anthropic/claude-haiku-4-5',
          reasoning: null,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        prices,
      ),
    ).toThrow(UnpricedModelError)
  })
})

describe('weekly allowance', () => {
  // The allowance is granted again each week from midnight UTC of its day: what was spent before
  // that no longer counts, and what remains never goes below zero.
  it('counts only the charges of the current week and resets on its day', () => {
    const allowance = { weekly: 100, startsOn: 1 } as const
    const now = new Date('2026-11-04T12:00:00Z') // a Wednesday
    expect(weekStart(now, 1).toISOString()).toBe('2026-11-02T00:00:00.000Z')
    const state = allowanceAt(
      allowance,
      [
        { at: '2026-11-01T23:59:00Z', credits: 90 },
        { at: '2026-11-02T00:00:00Z', credits: 30 },
        { at: '2026-11-04T11:00:00Z', credits: 80 },
      ],
      now,
    )
    expect(state).toEqual({
      used: 110,
      remaining: 0,
      resetsAt: new Date('2026-11-09T00:00:00Z'),
    })
  })
})
