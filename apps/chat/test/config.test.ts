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
  it('lit le mode d’amorçage par défaut', () => {
    expect(readConfig(base)).toMatchObject({
      auth: { kind: 'bootstrap' },
      electricUrl: 'http://electric:3000',
    })
  })

  // Une instance mal configurée ne doit pas démarrer à moitié : le message nomme la variable.
  it('arrête le démarrage en nommant la valeur manquante', () => {
    expect(() => readConfig({ ...base, WICA_SESSION_SECRET: '' })).toThrow(/WICA_SESSION_SECRET/)
    expect(() => readConfig({ ...base, WICA_AUTH: 'oidc' })).toThrow(/OIDC_ISSUER/)
    expect(() => readConfig({ ...base, WICA_MODEL_URL: 'http://m/v1' })).toThrow(ConfigError)
  })
})

describe('modèle d’une conversation', () => {
  it('lit le modèle par défaut et un modèle hébergé', () => {
    expect(parseModelChoice(null)).toEqual({ kind: 'default' })
    expect(parseModelChoice('pi:anthropic/claude-opus-5-5')).toEqual({
      kind: 'pi',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    })
    expect(parseModelChoice('autre')).toBeNull()
  })

  it('lit un faux modèle et refuse un nom inconnu', () => {
    expect(parseModelChoice('lorem:lorem-tools')).toEqual({ kind: 'lorem', model: 'lorem-tools' })
    expect(parseModelChoice('lorem:autre')).toBeNull()
  })

  // Une vraie instance ne doit jamais répondre du lorem : sans la variable, le faux modèle est refusé.
  it('ne sert les faux modèles que si WICA_TEST_MODELS vaut 1', () => {
    expect(() => readConfig({ ...base, WICA_TEST_MODELS: 'oui' })).toThrow(/WICA_TEST_MODELS/)
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

describe('réveils sur Cloudflare Queues', () => {
  // Queues refuse un délai de plus de 24 h : un réveil plus lointain part au plus tard, puis est relayé.
  it('borne le délai d’un réveil lointain à la limite de Queues', async () => {
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
