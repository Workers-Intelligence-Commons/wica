import { describe, expect, it } from 'vite-plus/test'

import type { SignInPrompts } from '../src/server/data.ts'
import type { ModelTokens, PersonTokens } from '../src/server/tokens.ts'
import { loginFlow } from '../src/server/models.ts'

const prompts: SignInPrompts = {
  open: async () => 'login-1',
  ask: async () => {},
  answer: async () => null,
  reply: async () => false,
  close: async () => {},
}

const person: PersonTokens = {
  read: async () => undefined,
  list: async () => [],
  modify: async () => undefined,
  delete: async () => {},
  markWarned: async () => false,
}
const tokens: ModelTokens = { forUser: () => person }

describe('subscription sign-in of a model provider', () => {
  // The hub never runs on the person's computer: a sign-in that returns the browser to an
  // address on that computer cannot finish, so the hub takes the method made for remote use.
  it('signs in to Anthropic through the page that shows a code to paste', async () => {
    const stop = new AbortController()
    const events = []
    for await (const event of loginFlow(prompts, tokens, 'u1', 'anthropic', stop.signal)) {
      events.push(event)
      // The person leaves at the paste step; the sign-in ends with the request.
      if (event.type === 'prompt') {
        stop.abort()
        break
      }
    }

    const [opened, asked] = events
    expect(opened?.type).toBe('notify')
    const url = new URL((opened as { event: { url: string } }).event.url)
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    )
    expect(asked).toMatchObject({ type: 'prompt', prompt: { type: 'manual_code' } })
  })
})
