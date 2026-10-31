// Configuration du chat, lue dans les variables d'environnement, les mêmes dans le Compose et
// sur Workers. Une valeur manquante ou invalide arrête le démarrage avec un message qui la nomme.

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
  /** Clé de l'instance (32 octets en base64), qui chiffre les jetons de modèle. */
  instanceKey: string
  /** Jeton d'admin initial : création des premiers comptes et de leurs clés. */
  adminToken?: string
  auth: AuthConfig
  /** Service de modèle par défaut (wic-serving), en Open Responses. */
  model?: { url: string; id: string; apiKey?: string }
  /** Faux modèles de `@wica/testing/lorem`, proposés à côté des autres pour essayer le chat. */
  testModels: boolean
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Env = Record<string, string | undefined>

const required = (env: Env, name: string, help: string) => {
  const value = env[name]?.trim()
  if (!value) throw new ConfigError(`${name} est requis : ${help}`)
  return value
}

const optional = (env: Env, name: string) => env[name]?.trim() || undefined

export function readConfig(env: Env, databaseUrl = env.DATABASE_URL): ChatConfig {
  const sessionSecret = required(env, 'WICA_SESSION_SECRET', 'secret de signature des sessions.')
  if (sessionSecret.length < 32) {
    throw new ConfigError('WICA_SESSION_SECRET doit faire au moins 32 caractères.')
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
      issuer: required(env, 'OIDC_ISSUER', 'adresse de l’émetteur OIDC.'),
      clientId: required(env, 'OIDC_CLIENT_ID', 'identifiant du client OIDC de l’application.'),
      redirectUri: required(env, 'OIDC_REDIRECT_URI', 'adresse de retour, …/auth/callback.'),
      ...(clientSecret ? { clientSecret } : {}),
      ...(orgsClaim ? { orgsClaim } : {}),
      ...(rolesClaim ? { rolesClaim } : {}),
    }
  } else if (kind === 'proxy') {
    const nameHeader = optional(env, 'PROXY_NAME_HEADER')
    const groupsHeader = optional(env, 'PROXY_GROUPS_HEADER')
    auth = {
      kind,
      userHeader: required(env, 'PROXY_USER_HEADER', 'en-tête du sujet authentifié par le proxy.'),
      proxies: required(env, 'PROXY_ADDRESSES', 'adresses du proxy, séparées par des virgules.')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      ...(nameHeader ? { nameHeader } : {}),
      ...(groupsHeader ? { groupsHeader } : {}),
    }
  } else {
    throw new ConfigError('WICA_AUTH doit valoir bootstrap, oidc ou proxy.')
  }
  const modelUrl = optional(env, 'WICA_MODEL_URL')
  const modelId = optional(env, 'WICA_MODEL')
  if (Boolean(modelUrl) !== Boolean(modelId)) {
    throw new ConfigError('WICA_MODEL_URL et WICA_MODEL vont ensemble.')
  }
  const modelKey = optional(env, 'WICA_API_KEY')
  const testModels = optional(env, 'WICA_TEST_MODELS')
  if (testModels !== undefined && testModels !== '1') {
    throw new ConfigError('WICA_TEST_MODELS vaut 1 ou reste vide.')
  }
  const electricSecret = optional(env, 'ELECTRIC_SECRET')
  const adminToken = optional(env, 'WICA_ADMIN_TOKEN')
  return {
    databaseUrl: databaseUrl?.trim() || required(env, 'DATABASE_URL', 'adresse de la base chat.'),
    electricUrl: required(env, 'ELECTRIC_URL', 'adresse d’Electric, vue depuis l’application.'),
    sessionSecret,
    instanceKey: required(env, 'WICA_INSTANCE_KEY', '32 octets aléatoires en base64.'),
    auth,
    testModels: testModels === '1',
    ...(electricSecret ? { electricSecret } : {}),
    ...(adminToken ? { adminToken } : {}),
    ...(modelUrl && modelId
      ? { model: { url: modelUrl, id: modelId, ...(modelKey ? { apiKey: modelKey } : {}) } }
      : {}),
  }
}
