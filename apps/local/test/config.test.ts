import { describe, expect, it } from 'vite-plus/test'

import { ConfigError, configFromEnv } from '../src/server.ts'

const rest = { root: '/tmp', allowAll: false }

describe('modèle du binaire local', () => {
  it('accepte un faux modèle sans adresse de service', () => {
    const config = configFromEnv({ WICA_MODEL: 'lorem-tools' }, rest)
    expect(config.model).toBe('lorem-tools')
    expect(config.modelUrl).toBeUndefined()
  })

  it('exige une adresse pour tout autre modèle', () => {
    expect(() => configFromEnv({ WICA_MODEL: 'qwen' }, rest)).toThrow(ConfigError)
    expect(
      configFromEnv({ WICA_MODEL: 'lorem', WICA_MODEL_URL: 'http://m/v1' }, rest),
    ).toMatchObject({ model: 'lorem', modelUrl: 'http://m/v1' })
  })
})
