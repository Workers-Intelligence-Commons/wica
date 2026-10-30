// Compaction de bout en bout : le serveur demande un résumé au modèle
// quand la vue dépasse le seuil, l'écrit en événement `compacted`, puis répond sur la vue résumée.

import { compactPath, journalViolations } from '@wica/core'
import { createHarness } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

describe('compaction', () => {
  it('résume le passé, l’écrit dans le journal, et répond sur la vue résumée', async () => {
    const model = scriptedModel((request) =>
      request.summarize
        ? { parts: [{ type: 'text', text: 'La personne a demandé un plan de voyage.' }] }
        : { parts: [{ type: 'text', text: 'Voici la suite du plan, assez détaillée.' }] },
    )
    const harness = createHarness({
      model,
      policy: { freeText: 'direct', compaction: { maxChars: 60 } },
    })
    for await (const _ of harness.run('Prépare un plan de voyage en Bretagne.', {
      conversationId: 'c',
    }));
    for await (const _ of harness.run('Et le deuxième jour ?', { conversationId: 'c' }));

    const summarizing = model.requests.filter((r) => r.summarize)
    expect(summarizing).toHaveLength(1)
    expect(summarizing[0]?.tools).toEqual([])
    const answer = model.requests.at(-1)
    expect(answer?.summarize).toBeUndefined()
    expect(compactPath(answer?.path ?? []).slice(0, 2)).toMatchObject([
      { kind: 'summary', text: 'La personne a demandé un plan de voyage.' },
      { kind: 'user_message', parts: [{ type: 'text', text: 'Et le deuxième jour ?' }] },
    ])
    const { items } = await harness.store.load('c', 0)
    expect(items.filter((i) => i.kind === 'event' && i.name === 'compacted')).toHaveLength(1)
    // Rien n'est supprimé : la première demande reste dans le journal.
    expect(items.filter((i) => i.kind === 'user_message')).toHaveLength(2)
    expect(journalViolations(items)).toEqual([])
  })
})
