// Hub configuration, read from the environment variables; only the storage differs between
// Compose and Workers.
// A missing or invalid value stops startup with a message that names it.

export type AuthConfig =
  /** Accounts kept by the hub (Better Auth), with email and password. */
  | { kind: 'accounts' }
  | {
      kind: 'oidc'
      issuer: string
      clientId: string
      clientSecret?: string
      redirectUri: string
      orgsClaim?: string
      rolesClaim?: string
    }

/** Storage of the target: Postgres and Electric on Compose, the Cloudflare bindings on Workers. */
export type PgStorage = {
  kind: 'pg'
  databaseUrl: string
  electricUrl: string
  electricSecret?: string
}
export type StorageConfig = PgStorage | { kind: 'cloudflare' }

export type HubConfig = {
  storage: StorageConfig
  sessionSecret: string
  /** Instance key (32 bytes in base64), which encrypts the model tokens. */
  instanceKey: string
  /** Admin token, for the administration API. */
  adminToken?: string
  auth: AuthConfig
  /** Default model service (wic-serving), over Open Responses. */
  model?: { url: string; id: string; apiKey?: string }
  /** Fake models from `@wica/testing/lorem`, offered next to the others for trying the hub. */
  testModels: boolean
  /**
   * People without an account may talk to the default model, up to `dailyLimit` messages a day;
   * absent when the instance does not accept guests.
   */
  guests?: { dailyLimit: number }
  /** Sites whose pages may hold the guest chat component, by origin; absent, none may. */
  embed?: { origins: string[] }
}

/** Messages a guest may send each day when the instance does not set its own number. */
export const GUEST_DAILY_LIMIT = 20

/** A scheme, a host and an optional port, as a browser sends in `Origin`. */
function isOrigin(text: string) {
  try {
    const url = new URL(text)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === text
  } catch {
    return false
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Env = Record<string, string | undefined>

const required = (env: Env, name: string, help: string) => {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`${name} is required: ${help}`)
  return value
}

const optional = (env: Env, name: string) => env[name]?.trim() || undefined

export function readConfig(env: Env): HubConfig & { storage: PgStorage }
export function readConfig(
  env: Env,
  target: 'workers',
): HubConfig & { storage: { kind: 'cloudflare' } }
export function readConfig(env: Env, target: 'node' | 'workers' = 'node'): HubConfig {
  const sessionSecret = required(env, 'WICA_SESSION_SECRET', 'session signing secret.')
  if (sessionSecret.length < 32) {
    throw new ConfigError('WICA_SESSION_SECRET must be at least 32 characters.')
  }
  const kind = optional(env, 'WICA_AUTH') ?? 'accounts'
  let auth: AuthConfig
  if (kind === 'accounts') auth = { kind }
  else if (kind === 'oidc') {
    const clientSecret = optional(env, 'OIDC_CLIENT_SECRET')
    const orgsClaim = optional(env, 'OIDC_ORGS_CLAIM')
    const rolesClaim = optional(env, 'OIDC_ROLES_CLAIM')
    auth = {
      kind,
      issuer: required(env, 'OIDC_ISSUER', 'address of the OIDC issuer.'),
      clientId: required(env, 'OIDC_CLIENT_ID', 'identifier of the application OIDC client.'),
      redirectUri: required(env, 'OIDC_REDIRECT_URI', 'return address, …/auth/callback.'),
      ...(clientSecret ? { clientSecret } : {}),
      ...(orgsClaim ? { orgsClaim } : {}),
      ...(rolesClaim ? { rolesClaim } : {}),
    }
  } else {
    throw new ConfigError('WICA_AUTH must be accounts or oidc.')
  }
  const modelUrl = optional(env, 'WICA_MODEL_URL')
  const modelId = optional(env, 'WICA_MODEL')
  if (Boolean(modelUrl) !== Boolean(modelId)) {
    throw new ConfigError('WICA_MODEL_URL and WICA_MODEL go together.')
  }
  const modelKey = optional(env, 'WICA_API_KEY')
  const testModels = optional(env, 'WICA_TEST_MODELS')
  if (testModels !== undefined && testModels !== '1') {
    throw new ConfigError('WICA_TEST_MODELS is 1 or stays empty.')
  }
  const guests = optional(env, 'WICA_GUESTS')
  if (guests !== undefined && guests !== '1') {
    throw new ConfigError('WICA_GUESTS is 1 or stays empty.')
  }
  if (guests && !modelId) {
    throw new ConfigError('WICA_GUESTS needs WICA_MODEL: guests talk to the default model only.')
  }
  const limitText = optional(env, 'WICA_GUEST_DAILY_LIMIT')
  const dailyLimit = limitText === undefined ? GUEST_DAILY_LIMIT : Number(limitText)
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
    throw new ConfigError('WICA_GUEST_DAILY_LIMIT is a whole number of messages, 1 or more.')
  }
  const embedOrigins = (optional(env, 'WICA_EMBED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (embedOrigins.length > 0 && !guests) {
    throw new ConfigError('WICA_EMBED_ORIGINS needs WICA_GUESTS: the component is a guest chat.')
  }
  for (const origin of embedOrigins) {
    if (!isOrigin(origin)) {
      throw new ConfigError(
        `WICA_EMBED_ORIGINS holds origins such as https://example.org, separated by commas; "${origin}" is not one.`,
      )
    }
  }
  const electricSecret = optional(env, 'ELECTRIC_SECRET')
  const adminToken = optional(env, 'WICA_ADMIN_TOKEN')
  const storage: StorageConfig =
    target === 'workers'
      ? { kind: 'cloudflare' }
      : {
          kind: 'pg',
          databaseUrl: required(env, 'DATABASE_URL', 'address of the chat database.'),
          electricUrl: required(
            env,
            'ELECTRIC_URL',
            'address of Electric, as seen from the application.',
          ),
          ...(electricSecret ? { electricSecret } : {}),
        }
  return {
    storage,
    sessionSecret,
    instanceKey: required(env, 'WICA_INSTANCE_KEY', '32 random bytes in base64.'),
    auth,
    testModels: testModels === '1',
    ...(guests ? { guests: { dailyLimit } } : {}),
    ...(embedOrigins.length > 0 ? { embed: { origins: embedOrigins } } : {}),
    ...(adminToken ? { adminToken } : {}),
    ...(modelUrl && modelId
      ? { model: { url: modelUrl, id: modelId, ...(modelKey ? { apiKey: modelKey } : {}) } }
      : {}),
  }
}
