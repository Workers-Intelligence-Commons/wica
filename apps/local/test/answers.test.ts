import type { AskUserInput } from '@wica/tools-user'
import { describe, expect, it } from 'vite-plus/test'

import { elicitFields, parseAnswer, parseElicitField, parseField } from '../src/answers.ts'

const choice: AskUserInput = {
  kind: 'choice',
  question: 'Which folder?',
  options: [{ label: 'src' }, { label: 'test' }],
}

describe('answers typed in the terminal', () => {
  it('reads an option number, multiple numbers and a confirmation', () => {
    expect(parseAnswer(choice, '2')).toEqual({ ok: { kind: 'choice', label: 'test' } })
    expect(parseAnswer({ ...choice, kind: 'multiple' }, '1, 2')).toEqual({
      ok: { kind: 'multiple', labels: ['src', 'test'] },
    })
    expect(parseAnswer({ kind: 'confirm', question: 'Sure?' }, 'yes')).toEqual({
      ok: { kind: 'confirm', yes: true },
    })
  })

  it('asks again when the input matches no possible answer', () => {
    expect(parseAnswer(choice, '3')).toEqual({ error: 'Choose between 1 and 2.' })
    expect(parseAnswer(choice, '1,2')).toEqual({ error: 'Only one number.' })
    expect(parseField({ name: 'n', label: 'N', type: 'number', required: true }, '')).toEqual({
      error: 'This field is required.',
    })
  })

  it('reads the fields of a form according to their type', () => {
    expect(parseField({ name: 'n', label: 'N', type: 'number' }, '3,5')).toEqual({ ok: 3.5 })
    expect(parseField({ name: 'c', label: 'C', type: 'choice', options: ['a', 'b'] }, '2')).toEqual(
      {
        ok: 'b',
      },
    )
    expect(parseField({ name: 's', label: 'S', type: 'string' }, '')).toEqual({ ok: null })
  })

  it('turns the schema of an MCP request into fields, and reads a multiple-choice list', () => {
    const fields = elicitFields({
      type: 'object',
      properties: {
        city: { type: 'string', title: 'City' },
        class: { type: 'string', oneOf: [{ const: 'economy' }, { const: 'business' }] },
        seats: { type: 'integer' },
        return: { type: 'boolean' },
        meals: { type: 'array', items: { enum: ['vegan', 'gluten-free'] } },
      },
      required: ['city'],
    })
    expect(fields).toEqual([
      { name: 'city', label: 'City', type: 'string', required: true },
      {
        name: 'class',
        label: 'class',
        type: 'choice',
        options: ['economy', 'business'],
        required: false,
      },
      { name: 'seats', label: 'seats', type: 'number', required: false },
      { name: 'return', label: 'return', type: 'boolean', required: false },
      {
        name: 'meals',
        label: 'meals',
        type: 'string',
        required: false,
        list: true,
        options: ['vegan', 'gluten-free'],
      },
    ])
    expect(parseElicitField(fields[4]!, 'vegan, gluten-free')).toEqual({
      ok: ['vegan', 'gluten-free'],
    })
    expect(parseElicitField(fields[4]!, 'meat')).toHaveProperty('error')
  })
})
