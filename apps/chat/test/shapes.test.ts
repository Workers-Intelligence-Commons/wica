import { describe, expect, it } from 'vite-plus/test'

import { proxiedResponse, shapeSpec, upstreamUrl } from '../src/server/shapes.ts'

describe('proxy des shapes', () => {
  // Le client ne doit jamais choisir ce qu'il lit : la shape vient du serveur, pour le compte de la requête.
  it('ignore la table, le filtre et les colonnes du client et ajoute le secret', () => {
    const spec = shapeSpec('items', { owner: 'u1', conversationId: 'c1' })
    if (!spec) throw new Error('shape attendue')
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

  it('ne sert pas de shape de conversation sans conversation vérifiée', () => {
    expect(shapeSpec('items', { owner: 'u1' })).toBeNull()
    expect(shapeSpec('commands', { owner: 'u1' })).toBeNull()
  })

  it('ne transmet jamais le hachage du jeton d’un serveur', () => {
    expect(shapeSpec('servers', { owner: 'u1' })?.columns).not.toContain('token_hash')
  })

  // Un cache partagé ne doit pas resservir la shape d'une personne à une autre.
  it('rend la réponse d’Electric avec Vary et sans en-têtes de compression', async () => {
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
