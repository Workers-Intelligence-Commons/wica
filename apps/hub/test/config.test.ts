import { describe, expect, it } from 'vite-plus/test'

import { ConfigError, readConfig } from '../src/server/config.ts'
import { conversationModel, NoModelError, parseModelChoice } from '../src/server/models.ts'

const base = {
  WICA_SESSION_SECRET: 's'.repeat(32),
  WICA_INSTANCE_KEY: Buffer.alloc(32, 1).toString('base64'),
  DATABASE_URL: 'postgresql://chat_app@db/chat',
  ELECTRIC_URL: 'http://electric:3000',
}

describe('configuration', () => {
  it('reads the accounts mode by default', () => {
    expect(readConfig(base)).toMatchObject({
      auth: { kind: 'accounts' },
      storage: { kind: 'pg', electricUrl: 'http://electric:3000' },
    })
  })

  // A Workers instance runs on its Cloudflare bindings alone: no Postgres, no Electric.
  it('needs no database or Electric address on Workers', () => {
    const { DATABASE_URL: _db, ELECTRIC_URL: _electric, ...cloudflare } = base
    expect(readConfig(cloudflare, 'workers').storage).toEqual({ kind: 'cloudflare' })
    expect(() => readConfig(cloudflare)).toThrow(/DATABASE_URL/)
  })

  // A misconfigured instance must not start halfway: the message names the variable.
  it('stops startup by naming the missing value', () => {
    expect(() => readConfig({ ...base, WICA_SESSION_SECRET: '' })).toThrow(/WICA_SESSION_SECRET/)
    expect(() => readConfig({ ...base, WICA_AUTH: 'oidc' })).toThrow(/OIDC_ISSUER/)
    expect(() => readConfig({ ...base, WICA_MODEL_URL: 'http://m/v1' })).toThrow(ConfigError)
  })

  // The browser compares the `Origin` it sends with each listed site exactly: an entry with a
  // path or a trailing slash would never match, so it stops startup instead.
  it('lists the sites that may embed the guest chat, as origins', () => {
    const guests = { ...base, WICA_GUESTS: '1', WICA_MODEL: 'wpt', WICA_MODEL_URL: 'http://m/v1' }
    expect(
      readConfig({ ...guests, WICA_EMBED_ORIGINS: 'https://asso.example, http://localhost:8000' })
        .embed,
    ).toEqual({ origins: ['https://asso.example', 'http://localhost:8000'] })
    expect(readConfig(guests).embed).toBeUndefined()
    expect(() => readConfig({ ...guests, WICA_EMBED_ORIGINS: 'https://asso.example/' })).toThrow(
      /WICA_EMBED_ORIGINS/,
    )
    expect(() => readConfig({ ...base, WICA_EMBED_ORIGINS: 'https://asso.example' })).toThrow(
      /WICA_GUESTS/,
    )
  })
})

describe('model of a conversation', () => {
  it('reads the default model and a hosted model', () => {
    expect(parseModelChoice(null)).toEqual({ kind: 'default' })
    expect(parseModelChoice('pi:anthropic/claude-opus-5-5')).toEqual({
      kind: 'pi',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    })
    expect(parseModelChoice('other')).toBeNull()
  })

  it('reads a fake model and refuses an unknown name', () => {
    expect(parseModelChoice('lorem:lorem-tools')).toEqual({ kind: 'lorem', model: 'lorem-tools' })
    expect(parseModelChoice('lorem:other')).toBeNull()
  })

  // A real instance must never answer with lorem: without the variable, the fake model is refused.
  it('serves the fake models only if WICA_TEST_MODELS is 1', () => {
    expect(() => readConfig({ ...base, WICA_TEST_MODELS: 'yes' })).toThrow(/WICA_TEST_MODELS/)
    const lorem = { kind: 'lorem', model: 'lorem' } as const
    const unused = undefined as never
    expect(() => conversationModel(readConfig(base), unused, 'u', lorem)).toThrow(NoModelError)
    const on = readConfig({ ...base, WICA_TEST_MODELS: '1' })
    expect(on.testModels).toBe(true)
    expect(conversationModel(on, unused, 'u', lorem)).toHaveProperty('stream')
  })
})
