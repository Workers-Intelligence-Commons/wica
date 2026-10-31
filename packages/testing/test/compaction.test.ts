// End-to-end compaction: the server asks the model for a summary when the view exceeds the
// threshold, writes it as a `compacted` event, then answers on the summarized view.

import { compactPath, journalViolations } from '@wica/core'
import { createHarness } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

describe('compaction', () => {
  it('summarizes the past, writes it into the journal, and answers on the summarized view', async () => {
    const model = scriptedModel((request) =>
      request.summarize
        ? { parts: [{ type: 'text', text: 'The person asked for a travel plan.' }] }
        : { parts: [{ type: 'text', text: 'Here is the rest of the plan, in detail.' }] },
    )
    const harness = createHarness({
      model,
      policy: { freeText: 'direct', compaction: { maxChars: 60 } },
    })
    for await (const _ of harness.run('Prepare a travel plan for Brittany.', {
      conversationId: 'c',
    }));
    for await (const _ of harness.run('And the second day?', { conversationId: 'c' }));

    const summarizing = model.requests.filter((r) => r.summarize)
    expect(summarizing).toHaveLength(1)
    expect(summarizing[0]?.tools).toEqual([])
    const answer = model.requests.at(-1)
    expect(answer?.summarize).toBeUndefined()
    expect(compactPath(answer?.path ?? []).slice(0, 2)).toMatchObject([
      { kind: 'summary', text: 'The person asked for a travel plan.' },
      { kind: 'user_message', parts: [{ type: 'text', text: 'And the second day?' }] },
    ])
    const { items } = await harness.store.load('c', 0)
    expect(items.filter((i) => i.kind === 'event' && i.name === 'compacted')).toHaveLength(1)
    // Nothing is deleted: the first request stays in the journal.
    expect(items.filter((i) => i.kind === 'user_message')).toHaveLength(2)
    expect(journalViolations(items)).toEqual([])
  })
})
