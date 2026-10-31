// Rendering of the active path shared by all API formats: what the model reads, in order, without the shape of a provider.
// Each codec translates these entries into its format and keeps the sorting of opaque data to itself.

import { compactPath, HARNESS_TOOLS, type Item, type ModelRequest, type Part } from '@wica/core'

export type TranscriptEntry =
  /** Entry read as speech: a person, an external event, a wake-up. */
  | { type: 'user'; parts: Part[] }
  /** Harness instruction at its place in the conversation: summary, branch resume. */
  | { type: 'developer'; text: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text?: string; opaque?: { provider: string; data: unknown } }
  | { type: 'tool_call'; callId: string; tool: string; input: unknown }
  | { type: 'tool_result'; callId: string; tool: string; output: Part[]; isError: boolean }

/** Minimal tool result that precedes the person's speech (Person's speech). */
export const USER_REPLY_ACK = 'Answer from the person received; it follows.'

/** Instruction of a summary request: what the rest of the work needs, nothing else. */
export const SUMMARY_PROMPT =
  'Summarize the conversation above for the rest of the work: requests from the person, established facts, decisions made, actions taken on the environment and their results, open questions. Write only the summary, without calling a tool.'

const text = (t: string): Part[] => [{ type: 'text', text: t }]

/** Calls added by the Harness itself (approvals, tool questions) do not come from the model. */
const fromHarness = (item: Item, own: Set<string>) =>
  (item.kind === 'tool_call' && item.channel === 'user' && HARNESS_TOOLS.includes(item.tool)) ||
  (item.kind === 'tool_result' && own.has(item.callId))

const externalEvent = (item: Extract<Item, { kind: 'external_event' }>): TranscriptEntry => ({
  type: 'user',
  parts: text(
    `External event (source: ${item.source}, name: ${item.name}, trust: ${item.trust}):\n${JSON.stringify(item.data)}`,
  ),
})

/**
 * A wake-up the agent gave itself. Its payload comes from the model, sometimes after an untrusted
 * input: it arrives as an input, never with the authority of instructions.
 */
function wakeupFired(data: unknown): TranscriptEntry {
  const d = (data ?? {}) as { id?: string; at?: string; payload?: unknown }
  return {
    type: 'user',
    parts: text(
      `Scheduled wake-up (identifier: ${d.id ?? '?'}, due at ${d.at ?? '?'}):\n${JSON.stringify(d.payload ?? null)}`,
    ),
  }
}

function branchResumed(data: unknown): TranscriptEntry {
  const calls = (data as { callIds?: string[] } | null)?.callIds ?? []
  return {
    type: 'developer',
    text: `The conversation resumes an older branch. The environment may have changed since${
      calls.length > 0 ? ` (calls made on another branch: ${calls.join(', ')})` : ''
    }: observe it again before acting on what you believe you know.`,
  }
}

/** Active path, compacted, to the entries the model reads. */
export function toTranscript(request: ModelRequest): TranscriptEntry[] {
  const path = compactPath(request.path)
  const approvals = new Set(
    path.flatMap((i) =>
      i.kind === 'tool_call' && i.channel === 'user' && HARNESS_TOOLS.includes(i.tool)
        ? [i.callId]
        : [],
    ),
  )
  const out: TranscriptEntry[] = []
  const tools = new Map<string, string>()
  // Tool results waiting to be rendered: they come out in the order of the calls, then the
  // person's speech in the same order, as soon as another item follows them.
  const callOrder: string[] = []
  let results: Extract<Item, { kind: 'tool_result' }>[] = []
  const flush = () => {
    if (results.length === 0) return
    const ordered = [...results].sort(
      (a, b) => callOrder.indexOf(a.callId) - callOrder.indexOf(b.callId),
    )
    for (const r of ordered) {
      out.push({
        type: 'tool_result',
        callId: r.callId,
        tool: tools.get(r.callId) ?? '',
        output: r.as === 'user' ? text(USER_REPLY_ACK) : r.output,
        isError: r.isError === true,
      })
    }
    for (const r of ordered) if (r.as === 'user') out.push({ type: 'user', parts: r.output })
    results = []
  }

  for (const item of path) {
    if (item.kind === 'summary') {
      flush()
      out.push({ type: 'developer', text: `Summary of the conversation so far:\n${item.text}` })
      continue
    }
    if (fromHarness(item, approvals)) continue
    if (item.kind === 'tool_result') {
      results.push(item)
      continue
    }
    if (item.kind === 'event') {
      if (item.name === 'branch_resumed') {
        flush()
        out.push(branchResumed(item.data))
      } else if (item.name === 'wakeup_fired') {
        flush()
        out.push(wakeupFired(item.data))
      }
      continue
    }
    flush()
    switch (item.kind) {
      case 'user_message':
        out.push({ type: 'user', parts: item.parts })
        break
      case 'external_event':
        out.push(externalEvent(item))
        break
      case 'assistant_text':
        if (item.text !== '') out.push({ type: 'assistant_text', text: item.text })
        break
      case 'reasoning':
        out.push({
          type: 'reasoning',
          ...(item.text !== undefined ? { text: item.text } : {}),
          ...(item.opaque ? { opaque: item.opaque } : {}),
        })
        break
      case 'tool_call':
        callOrder.push(item.callId)
        tools.set(item.callId, item.tool)
        out.push({ type: 'tool_call', callId: item.callId, tool: item.tool, input: item.input })
        break
    }
  }
  flush()
  if (request.summarize) out.push({ type: 'developer', text: SUMMARY_PROMPT })
  return out
}
