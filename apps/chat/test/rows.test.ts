import type { Item, ItemDraft } from '@wica/core'
import { describe, expect, it } from 'vite-plus/test'

import { BLOB_THRESHOLD, draftToRow, restoreItem, rowToItem } from '../src/shared/rows.ts'

const result = (text: string): ItemDraft => ({
  id: 'r1',
  parentId: 'c1',
  at: '2026-10-31T00:00:00.000Z',
  status: 'done',
  kind: 'tool_result',
  callId: 'call-1',
  output: [{ type: 'text', text }],
})

const asItem = (payload: Record<string, unknown>): Item =>
  rowToItem({ id: 'r1', parent_id: 'c1', seq: 4, status: 'done', payload })

describe('item rows', () => {
  // The sync must not carry a large tool result, but the model must read it again in full.
  it('sets aside a large tool result, syncs a preview and restores the full item', () => {
    const draft = result('x'.repeat(BLOB_THRESHOLD + 10))
    const { payload, blob } = draftToRow(draft)
    expect(blob?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const synced = asItem(payload)
    expect(
      synced.kind === 'tool_result' &&
        synced.output[0]?.type === 'text' &&
        synced.output[0].text.length,
    ).toBeLessThan(2_100)
    expect(restoreItem(synced, blob?.output)).toEqual({ ...draft, seq: 4 })
  })

  it('keeps a result under the threshold as it is', () => {
    const draft = result('short')
    const { payload, blob } = draftToRow(draft)
    expect(blob).toBeNull()
    expect(asItem(payload)).toEqual({ ...draft, seq: 4 })
  })
})
