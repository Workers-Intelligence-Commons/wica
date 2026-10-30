import { MemoryCredentialStore } from '@wica/runtime'
import { describe, expect, it } from 'vite-plus/test'

import { authorizedFetch } from '../src/index.ts'

describe('authorizedFetch', () => {
  // Un jeton refusé est rafraîchi une fois, puis la requête est rejouée avec le nouveau.
  it('rafraîchit le jeton refusé et rejoue la requête', async () => {
    const credentials = new MemoryCredentialStore({ refresh: async () => ({ token: 'neuf' }) })
    credentials.set('notes', { token: 'vieux' })
    const seen: (string | null)[] = []
    const server = async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization')
      seen.push(auth)
      return new Response(null, { status: auth === 'Bearer neuf' ? 200 : 401 })
    }
    const fetch = authorizedFetch(server, { store: credentials, key: 'notes' }, { 'x-wica': '1' })

    const response = await fetch('http://mcp/', { method: 'POST', body: '{}' })
    expect(response.status).toBe(200)
    expect(seen).toEqual(['Bearer vieux', 'Bearer neuf'])
    expect(await credentials.get('notes')).toEqual({ token: 'neuf' })
  })
})
