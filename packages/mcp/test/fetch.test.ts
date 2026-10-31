import { MemoryCredentialStore } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { authorizedFetch } from '../src/index.ts'

describe('authorizedFetch', () => {
  // A refused token is refreshed once, then the request is replayed with the new one.
  it('refreshes the refused token and replays the request', async () => {
    const credentials = new MemoryCredentialStore({ refresh: async () => ({ token: 'new' }) })
    credentials.set('notes', { token: 'old' })
    const seen: (string | null)[] = []
    const server = async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization')
      seen.push(auth)
      return new Response(null, { status: auth === 'Bearer new' ? 200 : 401 })
    }
    const fetch = authorizedFetch(server, { store: credentials, key: 'notes' }, { 'x-wica': '1' })

    const response = await fetch('http://mcp/', { method: 'POST', body: '{}' })
    expect(response.status).toBe(200)
    expect(seen).toEqual(['Bearer old', 'Bearer new'])
    expect(await credentials.get('notes')).toEqual({ token: 'new' })
  })
})
