import type { AskUserInput } from '@wica/tools-user'
import { describe, expect, it } from 'vite-plus/test'

import { elicitFields, parseAnswer, parseElicitField, parseField } from '../src/answers.ts'

const choice: AskUserInput = {
  kind: 'choice',
  question: 'Quel dossier ?',
  options: [{ label: 'src' }, { label: 'test' }],
}

describe('réponses tapées au terminal', () => {
  it('lit un numéro d’option, des numéros multiples et une confirmation', () => {
    expect(parseAnswer(choice, '2')).toEqual({ ok: { kind: 'choice', label: 'test' } })
    expect(parseAnswer({ ...choice, kind: 'multiple' }, '1, 2')).toEqual({
      ok: { kind: 'multiple', labels: ['src', 'test'] },
    })
    expect(parseAnswer({ kind: 'confirm', question: 'Sûr ?' }, 'oui')).toEqual({
      ok: { kind: 'confirm', yes: true },
    })
  })

  it('redemande quand la saisie ne correspond à aucune réponse possible', () => {
    expect(parseAnswer(choice, '3')).toEqual({ error: 'Choisis entre 1 et 2.' })
    expect(parseAnswer(choice, '1,2')).toEqual({ error: 'Un seul numéro.' })
    expect(parseField({ name: 'n', label: 'N', type: 'number', required: true }, '')).toEqual({
      error: 'Ce champ est requis.',
    })
  })

  it('lit les champs d’un formulaire selon leur type', () => {
    expect(parseField({ name: 'n', label: 'N', type: 'number' }, '3,5')).toEqual({ ok: 3.5 })
    expect(parseField({ name: 'c', label: 'C', type: 'choice', options: ['a', 'b'] }, '2')).toEqual(
      {
        ok: 'b',
      },
    )
    expect(parseField({ name: 's', label: 'S', type: 'string' }, '')).toEqual({ ok: null })
  })

  it('transforme le schéma d’une demande MCP en champs, et lit une liste à choix multiples', () => {
    const fields = elicitFields({
      type: 'object',
      properties: {
        ville: { type: 'string', title: 'Ville' },
        classe: { type: 'string', oneOf: [{ const: 'eco' }, { const: 'affaires' }] },
        places: { type: 'integer' },
        retour: { type: 'boolean' },
        repas: { type: 'array', items: { enum: ['vegan', 'sans gluten'] } },
      },
      required: ['ville'],
    })
    expect(fields).toEqual([
      { name: 'ville', label: 'Ville', type: 'string', required: true },
      {
        name: 'classe',
        label: 'classe',
        type: 'choice',
        options: ['eco', 'affaires'],
        required: false,
      },
      { name: 'places', label: 'places', type: 'number', required: false },
      { name: 'retour', label: 'retour', type: 'boolean', required: false },
      {
        name: 'repas',
        label: 'repas',
        type: 'string',
        required: false,
        list: true,
        options: ['vegan', 'sans gluten'],
      },
    ])
    expect(parseElicitField(fields[4]!, 'vegan, sans gluten')).toEqual({
      ok: ['vegan', 'sans gluten'],
    })
    expect(parseElicitField(fields[4]!, 'viande')).toHaveProperty('error')
  })
})
