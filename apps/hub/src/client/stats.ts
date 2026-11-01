// The line shown under a response: its model, its speed and its tokens. Only what was measured or
// reported is said; nothing is estimated.

import type { ModelCallRow } from '../shared/rows.ts'

const count = new Intl.NumberFormat('en')
/** Under a second in milliseconds, so that a fast first token does not read as zero. */
const seconds = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

/**
 * Output tokens per second of writing: from the first token to the end, or over the whole call
 * when no token came before the end.
 */
export function tokensPerSecond(call: ModelCallRow): number | null {
  if (call.output_tokens === null) return null
  const writing = call.duration_ms - (call.first_token_ms ?? 0)
  return writing > 0 ? (call.output_tokens * 1000) / writing : null
}

/** The parts of the line, in reading order. */
export function callDetails(call: ModelCallRow): string[] {
  const parts = [call.model_name]
  if (call.reasoning !== null) parts.push(`${call.reasoning} reasoning`)
  if (call.first_token_ms !== null) parts.push(`${seconds(call.first_token_ms)} to first token`)
  const speed = tokensPerSecond(call)
  if (speed !== null) parts.push(`${count.format(Math.round(speed))} tokens/s`)
  parts.push(`${seconds(call.duration_ms)} in all`)
  if (call.input_tokens !== null) {
    const cached = call.cache_read_tokens ?? 0
    const input = call.input_tokens + cached + (call.cache_write_tokens ?? 0)
    parts.push(
      cached > 0
        ? `${count.format(input)} in, ${count.format(cached)} cached`
        : `${count.format(input)} in`,
    )
  }
  if (call.output_tokens !== null) parts.push(`${count.format(call.output_tokens)} out`)
  return parts
}
