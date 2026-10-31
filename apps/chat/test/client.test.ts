import type { Item } from '@wica/core'
import { describe, expect, it } from 'vite-plus/test'

import { cacheName, evictionPlan } from '../src/client/cache.ts'
import { branchesOf, leafUnder, liveText } from '../src/client/view.ts'

describe('éviction du cache local', () => {
  it('évince les conversations ouvertes le plus anciennement au-delà du quota', () => {
    expect(evictionPlan({ a: 1, b: 2, c: 3, d: 4 }, new Set(), 2).sort()).toEqual(['a', 'b'])
  })

  // Un envoi pas encore confirmé ne doit pas perdre sa ligne locale.
  it('n’évince jamais une conversation qui a un envoi en attente', () => {
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

// Arbre : u1 → a1 → u2 → a2 ; u1 → r1 (régénération) → a1b ; a1 → u2b (message modifié) → a3.
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

describe('branches d’une conversation', () => {
  it('liste les versions d’un message dans leur ordre et sa place parmi elles', () => {
    const { siblings, index } = branchesOf(tree, 'u2b')
    expect(siblings.map((i) => i.id)).toEqual(['u2', 'u2b'])
    expect(index).toBe(1)
  })

  it('compte une réponse régénérée comme une version de la réponse d’origine', () => {
    const regenerated = branchesOf(tree, 'a1b')
    expect(regenerated.siblings.map((i) => i.id)).toEqual(['a1', 'r1'])
    expect(regenerated.index).toBe(1)
    expect(branchesOf(tree, 'a1').index).toBe(0)
  })

  it('affiche la dernière feuille sous la branche choisie', () => {
    expect(leafUnder(tree, 'a1')).toBe('a3')
    expect(leafUnder(tree, 'u2')).toBe('a2')
    expect(leafUnder(tree, 'r1')).toBe('a1b')
  })
})

describe('texte en flux', () => {
  // Les lots peuvent arriver dans le désordre ; l'écran suit leur idx.
  it('assemble les lots de chaque élément dans l’ordre de leur idx', () => {
    const text = liveText([
      { conversation_id: 'c', item_id: 'x', idx: 1, text: 'jour' },
      { conversation_id: 'c', item_id: 'y', idx: 0, text: 'autre' },
      { conversation_id: 'c', item_id: 'x', idx: 0, text: 'Bon' },
    ])
    expect(Object.fromEntries(text)).toEqual({ x: 'Bonjour', y: 'autre' })
  })
})

describe('fichiers du cache local', () => {
  // Le VFS de wa-sqlite refuse un chemin de plus de 64 caractères, suffixe `-journal` compris.
  it('donne des noms qui s’ouvrent dans l’OPFS', () => {
    const id = '01a1920e-e0e4-7218-b046-a23adc400155'
    for (const name of [cacheName(id), cacheName(id, id)]) {
      expect(`${name}-journal`.length).toBeLessThanOrEqual(64)
    }
    expect(cacheName(id, id)).not.toBe(cacheName(id))
  })
})
