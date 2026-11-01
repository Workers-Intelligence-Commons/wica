// Credits: what each request costs, and the weekly allowance they are drawn from. Nothing calls
// these functions yet: the prices and the allowances come from whoever wires them, and no request
// is refused for lack of credits.

import type { ReasoningLevel } from '@wica/core'

import type { ModelCallRow } from '../shared/rows.ts'

/** Credits for one million tokens of each kind. */
export type TokenPrices = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type CreditPrices = {
  /** A message the person sends. */
  userMessage: number
  /** Prices of each model, by its `conversations.model` value (`''` for the default model). */
  models: Record<string, TokenPrices>
  /** Prices of a model absent from `models`; without them, such a model has no price. */
  otherModels?: TokenPrices
  /** A tool call the model makes, by tool name; `otherTools` for the others. */
  tools: Record<string, number>
  otherTools: number
  /** Multiplies the tokens of a call made at this reasoning level; 1 when absent. */
  reasoning?: Partial<Record<ReasoningLevel, number>>
}

/** The requests that cost credits. */
export type CreditRequest =
  | { kind: 'user_message' }
  | {
      kind: 'model_call'
      /** `conversations.model`: `null` for the default model. */
      model: string | null
      reasoning: ReasoningLevel | null
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
  | { kind: 'tool_call'; tool: string }

export class UnpricedModelError extends Error {
  override name = 'UnpricedModelError'
}

const PER_TOKENS = 1_000_000

/** Credits of one request under `prices`. */
export function creditsOf(request: CreditRequest, prices: CreditPrices): number {
  switch (request.kind) {
    case 'user_message':
      return prices.userMessage
    case 'tool_call':
      return prices.tools[request.tool] ?? prices.otherTools
    case 'model_call': {
      const model = request.model ?? ''
      const price = prices.models[model] ?? prices.otherModels
      if (!price) throw new UnpricedModelError(`no price for the model "${model}"`)
      const factor = request.reasoning ? (prices.reasoning?.[request.reasoning] ?? 1) : 1
      const tokens =
        request.inputTokens * price.input +
        request.outputTokens * price.output +
        request.cacheReadTokens * price.cacheRead +
        request.cacheWriteTokens * price.cacheWrite
      return (tokens * factor) / PER_TOKENS
    }
  }
}

/** A recorded model call as a request; tokens the provider did not report count as none. */
export const modelCallRequest = (call: ModelCallRow): CreditRequest => ({
  kind: 'model_call',
  model: call.model,
  reasoning: call.reasoning,
  inputTokens: call.input_tokens ?? 0,
  outputTokens: call.output_tokens ?? 0,
  cacheReadTokens: call.cache_read_tokens ?? 0,
  cacheWriteTokens: call.cache_write_tokens ?? 0,
})

/** Credits granted each week, from midnight UTC of `startsOn` (0 is Sunday). */
export type Allowance = { weekly: number; startsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6 }

/** Start of the allowance week that holds `at`. */
export function weekStart(at: Date, startsOn: Allowance['startsOn']): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  const back = (at.getUTCDay() - startsOn + 7) % 7
  return new Date(midnight - back * 86_400_000)
}

/** A charge drawn from the allowance: when, and how many credits. */
export type Charge = { at: string; credits: number }

/**
 * The allowance at `now`: credits used since the week began, what remains (never below zero),
 * and when it is granted again.
 */
export function allowanceAt(allowance: Allowance, charges: Charge[], now: Date) {
  const start = weekStart(now, allowance.startsOn)
  const used = charges
    .filter((c) => {
      const at = Date.parse(c.at)
      return at >= start.getTime() && at <= now.getTime()
    })
    .reduce((sum, c) => sum + c.credits, 0)
  return {
    used,
    remaining: Math.max(0, allowance.weekly - used),
    resetsAt: new Date(start.getTime() + 7 * 86_400_000),
  }
}
