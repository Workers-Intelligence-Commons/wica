import { describe, expect, it } from 'vite-plus/test'

import { ConfigError, readConfig } from '../src/server/config.ts'
import { MAX_QUEUE_DELAY_SECONDS, queueScheduler } from '../src/server/hosting.ts'
import { conversationModel, NoModelError, parseModelChoice } from '../src/server/models.ts'

const base = {
  WICA_SESSION_SECRET: 's'.repeat(32),
  WICA_INSTANCE_KEY: Buffer.alloc(32, 1).toString('base64'),
  DATABASE_URL: 'postgresql://chat_app@db/chat',
  ELECTRIC_URL: 'http://electric:3000',
}

describe('configuration', () => {
  it('reads bootstrap mode by default', () => {
    expect(readConfig(base)).toMatchObject({
      auth: { kind: 'bootstrap' },
      electricUrl: 'http://electric:3000',
    })
  })

  // A misconfigured instance must not start halfway: the message names the variable.
  it('stops startup by naming the missing value', () => {
    expect(() => readConfig({ ...base, WICA_SESSION_SECRET: '' })).toThrow(/WICA_SESSION_SECRET/)
    expect(() => readConfig({ ...base, WICA_AUTH: 'oidc' })).toThrow(/OIDC_ISSUER/)
    expect(() => readConfig({ ...base, WICA_MODEL_URL: 'http://m/v1' })).toThrow(ConfigError)
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
    expect(() => conversationModel(readConfig(base), unused, unused, 'u', lorem)).toThrow(
      NoModelError,
    )
    const on = readConfig({ ...base, WICA_TEST_MODELS: '1' })
    expect(on.testModels).toBe(true)
    expect(conversationModel(on, unused, unused, 'u', lorem)).toHaveProperty('stream')
  })
})

describe('wake-ups on Cloudflare Queues', () => {
  // Queues refuses a delay longer than 24 h: a later wake-up leaves at the latest time, then is relayed.
  it('caps the delay of a distant wake-up at the Queues limit', async () => {
    const sent: unknown[] = []
    const scheduler = queueScheduler({
      send: async (body, options) => void sent.push([body, options]),
    })
    await scheduler.wake('c1', { afterMs: 3 * 24 * 3600 * 1000 })
    await scheduler.wake('c2')
    expect(sent).toEqual([
      [{ conversationId: 'c1' }, { delaySeconds: MAX_QUEUE_DELAY_SECONDS }],
      [{ conversationId: 'c2' }, {}],
    ])
  })
})
