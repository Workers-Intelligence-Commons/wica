import type { Item } from '@wica/core'
import { describe, expect, it } from 'vite-plus/test'

import { cacheName, evictionPlan } from '../src/client/cache.ts'
import { branchesOf, leafUnder, liveText } from '../src/client/view.ts'

describe('local cache eviction', () => {
  it('evicts the conversations opened longest ago beyond the quota', () => {
    expect(evictionPlan({ a: 1, b: 2, c: 3, d: 4 }, new Set(), 2).sort()).toEqual(['a', 'b'])
  })

  // A send not yet confirmed must not lose its local row.
  it('never evicts a conversation that has a pending send', () => {
    expect(evictionPlan({ a: 1, b: 2, c: 3 }, new Set(['a']), 1)).toEqual(['b'])
  })
})

const item = (
  id: string,
  parentId: string | null,
  seq: number,
  kind: 'user_message' | 'assistant_text' | 'regenerate',
): Item =>
  kind === 'user_message'
    ? { id, parentId, seq, at: '', status: 'done', kind, parts: [{ type: 'text', text: id }] }
    : kind === 'regenerate'
      ? { id, parentId, seq, at: '', status: 'done', kind: 'event', name: kind, data: {} }
      : { id, parentId, seq, at: '', status: 'done', kind, text: id, audience: 'user' }

// Tree: u1 → a1 → u2 → a2; u1 → r1 (regeneration) → a1b; a1 → u2b (edited message) → a3.
const tree = [
  item('u1', null, 1, 'user_message'),
  item('a1', 'u1', 2, 'assistant_text'),
  item('u2', 'a1', 3, 'user_message'),
  item('a2', 'u2', 4, 'assistant_text'),
  item('r1', 'u1', 5, 'regenerate'),
  item('a1b', 'r1', 6, 'assistant_text'),
  item('u2b', 'a1', 7, 'user_message'),
  item('a3', 'u2b', 8, 'assistant_text'),
]

describe('branches of a conversation', () => {
  it('lists the versions of a message in their order and its place among them', () => {
    const { siblings, index } = branchesOf(tree, 'u2b')
    expect(siblings.map((i) => i.id)).toEqual(['u2', 'u2b'])
    expect(index).toBe(1)
  })

  it('counts a regenerated response as a version of the original response', () => {
    const regenerated = branchesOf(tree, 'a1b')
    expect(regenerated.siblings.map((i) => i.id)).toEqual(['a1', 'r1'])
    expect(regenerated.index).toBe(1)
    expect(branchesOf(tree, 'a1').index).toBe(0)
  })

  it('shows the last leaf under the chosen branch', () => {
    expect(leafUnder(tree, 'a1')).toBe('a3')
    expect(leafUnder(tree, 'u2')).toBe('a2')
    expect(leafUnder(tree, 'r1')).toBe('a1b')
  })
})

describe('streaming text', () => {
  // Batches can arrive out of order; the screen follows their idx.
  it('assembles the batches of each item in the order of their idx', () => {
    const text = liveText([
      { conversation_id: 'c', item_id: 'x', idx: 1, text: 'lo' },
      { conversation_id: 'c', item_id: 'y', idx: 0, text: 'other' },
      { conversation_id: 'c', item_id: 'x', idx: 0, text: 'Hel' },
    ])
    expect(Object.fromEntries(text)).toEqual({ x: 'Hello', y: 'other' })
  })
})

describe('local cache files', () => {
  // The wa-sqlite VFS refuses a path longer than 64 characters, `-journal` suffix included.
  it('gives names that open in the OPFS', () => {
    const id = '01a1920e-e0e4-7218-b046-a23adc400155'
    for (const name of [cacheName(id), cacheName(id, id)]) {
      expect(`${name}-journal`.length).toBeLessThanOrEqual(64)
    }
    expect(cacheName(id, id)).not.toBe(cacheName(id))
  })
})
