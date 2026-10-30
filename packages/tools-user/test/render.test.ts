import type { Item } from '@wica/core'
import { describe, expect, it } from 'vite-plus/test'

import { renderAnswer } from '../src/index.ts'

const call = (tool: string): Extract<Item, { kind: 'tool_call' }> => ({
  id: 'c',
  parentId: null,
  seq: 1,
  at: 't',
  status: 'done',
  kind: 'tool_call',
  callId: 'k',
  tool,
  input: {},
  channel: 'user',
})

describe('renderAnswer', () => {
  // Le modèle lit la réponse comme la parole de la personne : elle doit être dans ses mots.
  it('rend chaque sorte de réponse dans les mots de la personne', () => {
    const ask = call('ask_user')
    const text = (value: unknown) => renderAnswer(ask, value)[0]
    expect(text({ kind: 'choice', label: 'Option B' })).toEqual({ type: 'text', text: 'Option B' })
    expect(text({ kind: 'multiple', labels: ['A', 'C'] })).toEqual({ type: 'text', text: 'A, C' })
    expect(text({ kind: 'text', text: 'Fais plutôt ça' })).toEqual({
      type: 'text',
      text: 'Fais plutôt ça',
    })
    expect(text({ kind: 'confirm', yes: false })).toEqual({ type: 'text', text: 'Non.' })
    expect(text({ kind: 'form', values: { nom: 'Ada', urgent: true } })).toEqual({
      type: 'text',
      text: 'nom : Ada\nurgent : oui',
    })
  })

  it('rend la réponse à une demande d’information MCP dans les mots de la personne', () => {
    const elicit = call('elicit')
    expect(
      renderAnswer(elicit, { action: 'accept', content: { ville: 'Lyon', tags: ['a', 'b'] } }),
    ).toEqual([{ type: 'text', text: 'ville : Lyon\ntags : a, b' }])
    expect(renderAnswer(elicit, { action: 'decline' })).toEqual([
      { type: 'text', text: 'Je refuse de répondre.' },
    ])
  })

  it('garde le texte brut ou le JSON pour les autres outils', () => {
    expect(renderAnswer(call('pick_file'), 'a.txt')).toEqual([{ type: 'text', text: 'a.txt' }])
    expect(renderAnswer(undefined, { x: 1 })).toEqual([{ type: 'text', text: '{"x":1}' }])
  })
})
