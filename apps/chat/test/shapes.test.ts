import { describe, expect, it } from 'vite-plus/test'

import { proxiedResponse, shapeSpec, upstreamUrl } from '../src/server/shapes.ts'

describe('shape proxy', () => {
  // The client must never choose what it reads: the shape comes from the server, for the account of the request.
  it('ignores the table, filter and columns of the client and adds the secret', () => {
    const spec = shapeSpec('items', { owner: 'u1', conversationId: 'c1' })
    if (!spec) throw new Error('shape expected')
    const client = new URL(
      'https://chat.test/api/shapes/items?offset=5_2&handle=h1&live=true&table=users&where=true&columns=*&params[1]=c2&secret=x&subset__where=1',
    )
    const url = upstreamUrl('http://electric:3000', 's3cret', spec, client)
    expect(url.origin + url.pathname).toBe('http://electric:3000/v1/shape')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      offset: '5_2',
      handle: 'h1',
      live: 'true',
      table: 'items',
      where: 'conversation_id = $1',
      'params[1]': 'c1',
      columns: 'conversation_id,id,parent_id,seq,kind,payload,status',
      secret: 's3cret',
    })
  })

  it('serves no conversation shape without a verified conversation', () => {
    expect(shapeSpec('items', { owner: 'u1' })).toBeNull()
    expect(shapeSpec('commands', { owner: 'u1' })).toBeNull()
  })

  it('never forwards the hash of a server token', () => {
    expect(shapeSpec('servers', { owner: 'u1' })?.columns).not.toContain('token_hash')
  })

  // A shared cache must not serve one person's shape to another again.
  it('returns the Electric response with Vary and without compression headers', async () => {
    const upstream = new Response('[]', {
      status: 200,
      headers: { 'content-encoding': 'gzip', 'content-length': '2', 'electric-handle': 'h1' },
    })
    const response = proxiedResponse(upstream)
    expect(response.headers.get('vary')).toBe('Cookie, Authorization')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('electric-handle')).toBe('h1')
    expect(await response.text()).toBe('[]')
  })
})
