// Chat configuration, read from the environment variables, the same in Compose and on Workers.
// A missing or invalid value stops startup with a message that names it.

export type AuthConfig =
  | { kind: 'bootstrap' }
  | {
      kind: 'oidc'
      issuer: string
      clientId: string
      clientSecret?: string
      redirectUri: string
      orgsClaim?: string
      rolesClaim?: string
    }
  | {
      kind: 'proxy'
      userHeader: string
      nameHeader?: string
      groupsHeader?: string
      proxies: string[]
    }

export type ChatConfig = {
  databaseUrl: string
  electricUrl: string
  electricSecret?: string
  sessionSecret: string
  /** Instance key (32 bytes in base64), which encrypts the model tokens. */
  instanceKey: string
  /** Initial admin token: creation of the first accounts and of their keys. */
  adminToken?: string
  auth: AuthConfig
  /** Default model service (wic-serving), over Open Responses. */
  model?: { url: string; id: string; apiKey?: string }
  /** Fake models from `@wica/testing/lorem`, offered next to the others for trying the chat. */
  testModels: boolean
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

export function readConfig(env: Env, databaseUrl = env.DATABASE_URL): ChatConfig {
  const sessionSecret = required(env, 'WICA_SESSION_SECRET', 'session signing secret.')
  if (sessionSecret.length < 32) {
    throw new ConfigError('WICA_SESSION_SECRET must be at least 32 characters.')
  }
  const kind = optional(env, 'WICA_AUTH') ?? 'bootstrap'
  let auth: AuthConfig
  if (kind === 'bootstrap') auth = { kind }
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
  } else if (kind === 'proxy') {
    const nameHeader = optional(env, 'PROXY_NAME_HEADER')
    const groupsHeader = optional(env, 'PROXY_GROUPS_HEADER')
    auth = {
      kind,
      userHeader: required(
        env,
        'PROXY_USER_HEADER',
        'header of the subject authenticated by the proxy.',
      ),
      proxies: required(env, 'PROXY_ADDRESSES', 'proxy addresses, separated by commas.')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      ...(nameHeader ? { nameHeader } : {}),
      ...(groupsHeader ? { groupsHeader } : {}),
    }
  } else {
    throw new ConfigError('WICA_AUTH must be bootstrap, oidc or proxy.')
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
  const electricSecret = optional(env, 'ELECTRIC_SECRET')
  const adminToken = optional(env, 'WICA_ADMIN_TOKEN')
  return {
    databaseUrl:
      databaseUrl?.trim() || required(env, 'DATABASE_URL', 'address of the chat database.'),
    electricUrl: required(
      env,
      'ELECTRIC_URL',
      'address of Electric, as seen from the application.',
    ),
    sessionSecret,
    instanceKey: required(env, 'WICA_INSTANCE_KEY', '32 random bytes in base64.'),
    auth,
    testModels: testModels === '1',
    ...(electricSecret ? { electricSecret } : {}),
    ...(adminToken ? { adminToken } : {}),
    ...(modelUrl && modelId
      ? { model: { url: modelUrl, id: modelId, ...(modelKey ? { apiKey: modelKey } : {}) } }
      : {}),
  }
}
