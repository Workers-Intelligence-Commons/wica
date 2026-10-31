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
  // The model reads the answer as the person's speech: it must be in their words.
  it('renders each kind of answer in the words of the person', () => {
    const ask = call('ask_user')
    const text = (value: unknown) => renderAnswer(ask, value)[0]
    expect(text({ kind: 'choice', label: 'Option B' })).toEqual({ type: 'text', text: 'Option B' })
    expect(text({ kind: 'multiple', labels: ['A', 'C'] })).toEqual({ type: 'text', text: 'A, C' })
    expect(text({ kind: 'text', text: 'Do that instead' })).toEqual({
      type: 'text',
      text: 'Do that instead',
    })
    expect(text({ kind: 'confirm', yes: false })).toEqual({ type: 'text', text: 'No.' })
    expect(text({ kind: 'form', values: { name: 'Ada', urgent: true } })).toEqual({
      type: 'text',
      text: 'name: Ada\nurgent: yes',
    })
  })

  it('renders the answer to an MCP information request in the words of the person', () => {
    const elicit = call('elicit')
    expect(
      renderAnswer(elicit, { action: 'accept', content: { city: 'Lyon', tags: ['a', 'b'] } }),
    ).toEqual([{ type: 'text', text: 'city: Lyon\ntags: a, b' }])
    expect(renderAnswer(elicit, { action: 'decline' })).toEqual([
      { type: 'text', text: 'I refuse to answer.' },
    ])
  })

  it('keeps the raw text or the JSON for the other tools', () => {
    expect(renderAnswer(call('pick_file'), 'a.txt')).toEqual([{ type: 'text', text: 'a.txt' }])
    expect(renderAnswer(undefined, { x: 1 })).toEqual([{ type: 'text', text: '{"x":1}' }])
  })
})
