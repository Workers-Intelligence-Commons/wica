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

describe('lignes des éléments', () => {
  // La synchro ne doit pas transporter un gros résultat d'outil, mais le modèle doit le relire en entier.
  it('met de côté un gros résultat d’outil, synchronise un aperçu et restaure l’élément complet', () => {
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

  it('garde tel quel un résultat sous le seuil', () => {
    const draft = result('court')
    const { payload, blob } = draftToRow(draft)
    expect(blob).toBeNull()
    expect(asItem(payload)).toEqual({ ...draft, seq: 4 })
  })
})
