import type { Item } from '@wica/core'
import { allowAll, createHarness, type Harness } from '@wica/runtime'
import { askUser } from '@wica/tools-user'
import { describe, expect, it } from 'vite-plus/test'

import { memoryFiles } from '../src/index.ts'
import { loremModel } from '../src/lorem.ts'

const journal = async (harness: Harness, conversationId: string) =>
  (await harness.store.load(conversationId, 0)).items

const texts = (items: Item[]) =>
  items.flatMap((i) => (i.kind === 'assistant_text' ? [{ text: i.text, status: i.status }] : []))

describe('faux modèles lorem', () => {
  it('écrit en flux une réponse de texte que le journal garde entière', async () => {
    const harness = createHarness({ model: loremModel('lorem', { delayMs: 0 }) })
    let streamed = ''
    for await (const event of harness.run('Hello', { conversationId: 'l1' })) {
      if (event.type === 'delta') streamed += event.text
    }
    const [reply] = texts(await journal(harness, 'l1'))
    expect(reply?.status).toBe('done')
    expect(reply?.text).toMatch(/^Lorem ipsum dolor sit amet[^]*\n\n\S/)
    expect(streamed).toBe(reply?.text)
  })

  it('appelle un outil de travail à chaque tour, jamais une question, puis répond', async () => {
    const harness = createHarness({
      model: loremModel('lorem-tools', { delayMs: 0 }),
      tools: [askUser, memoryFiles({ 'Lorem ipsum dolor sit amet.': 'contenu' })],
      authorize: allowAll,
    })
    for await (const _ of harness.run('Hello', { conversationId: 'l2' })) void _
    const items = await journal(harness, 'l2')
    const kinds = items
      .filter((i) => i.kind !== 'event')
      .map((i) =>
        i.kind === 'tool_call' ? `call:${i.tool}` : i.kind === 'tool_result' ? 'result' : i.kind,
      )
    expect(kinds).toEqual([
      'user_message',
      'assistant_text',
      'call:read_file',
      'result',
      'assistant_text',
    ])
    const result = items.find((i) => i.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.isError).toBeFalsy()
  })

  it('s’arrête en cours de flux quand on interrompt la réponse', async () => {
    const harness = createHarness({ model: loremModel('lorem', { delayMs: 20 }) })
    for await (const event of harness.run('Hello', { conversationId: 'l3' })) {
      if (event.type === 'delta') await harness.interrupt('l3')
    }
    const [reply] = texts(await journal(harness, 'l3'))
    expect(reply?.status).toBe('interrupted')
    expect(reply?.text.length).toBeLessThan(60)
  })
})
