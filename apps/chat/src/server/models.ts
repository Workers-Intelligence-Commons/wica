// Modèle d'une conversation : wic-serving en Open Responses par défaut, ou un fournisseur
// hébergé par pi-ai avec les jetons que la personne a connectés. Les jetons de l'instance
// (variables d'environnement, fichiers) ne servent jamais aux modèles des personnes.

import type { AuthContext, AuthEvent, AuthPrompt, Models } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { openResponsesModel } from '@wica/model-compat'
import { piModel } from '@wica/model-pi'
import { isLoremModel, LOREM_MODELS, loremModel, type LoremModel } from '@wica/testing/lorem'
import type { ModelAdapter } from '@wica/runtime'
import type postgres from 'postgres'

import type { ChatConfig } from './config.ts'
import type { InstanceKey } from './crypto.ts'
import { PgModelCredentials } from './hosting.ts'

export const SUBSCRIPTION_WARNING =
  'You just connected a personal subscription. The terms of some providers forbid using it ' +
  'from a third-party application and can lead to the suspension of the account. The token ' +
  'opens your account at this provider: it is stored encrypted, serves only your ' +
  'conversations, and you can revoke it at any time.'

export type ModelChoice =
  | { kind: 'default' }
  | { kind: 'pi'; provider: string; model: string }
  | { kind: 'lorem'; model: LoremModel }

/**
 * `conversations.model` : nul pour le modèle par défaut, `pi:<fournisseur>/<modèle>` pour un
 * fournisseur hébergé, `lorem:<modèle>` pour un faux modèle.
 */
export function parseModelChoice(value: string | null | undefined): ModelChoice | null {
  if (!value) return { kind: 'default' }
  const lorem = /^lorem:(.+)$/.exec(value)?.[1]
  if (lorem !== undefined) return isLoremModel(lorem) ? { kind: 'lorem', model: lorem } : null
  const match = /^pi:([^/]+)\/(.+)$/.exec(value)
  return match ? { kind: 'pi', provider: match[1] as string, model: match[2] as string } : null
}

/** Faux modèles proposés quand `WICA_TEST_MODELS` est actif. */
export const testModelOptions = () =>
  LOREM_MODELS.map((model) => ({
    id: `lorem:${model}`,
    name: model === 'lorem' ? 'Lorem ipsum (test)' : 'Lorem ipsum, a tool call each turn (test)',
  }))

/** Aucune source ambiante : ni variable d'environnement, ni fichier de la machine. */
const noAmbientAuth: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
}

export function userModels(sql: postgres.Sql, userId: string, key: InstanceKey) {
  const credentials = new PgModelCredentials(sql, userId, key)
  return { credentials, models: builtinModels({ credentials, authContext: noAmbientAuth }) }
}

export class NoModelError extends Error {
  override name = 'NoModelError'
}

export function conversationModel(
  config: ChatConfig,
  sql: postgres.Sql,
  key: InstanceKey,
  owner: string | null,
  choice: ModelChoice,
): ModelAdapter {
  if (choice.kind === 'lorem') {
    if (!config.testModels) throw new NoModelError('Test models are off (WICA_TEST_MODELS).')
    return loremModel(choice.model)
  }
  if (choice.kind === 'default') {
    if (!config.model) throw new NoModelError('No default model is configured (WICA_MODEL_URL).')
    return openResponsesModel({
      baseUrl: config.model.url,
      model: config.model.id,
      ...(config.model.apiKey ? { apiKey: config.model.apiKey } : {}),
    })
  }
  if (!owner) throw new NoModelError('This conversation has no owner, so no model token applies.')
  const { credentials, models } = userModels(sql, owner, key)
  return piModel({
    models,
    provider: choice.provider,
    model: choice.model,
    // L'avertissement a été montré à la connexion ; ceci couvre un jeton connecté autrement.
    onFirstSubscriptionUse: async (provider) => void (await credentials.markWarned(provider)),
  })
}

export type ProviderInfo = {
  id: string
  name: string
  apiKey: boolean
  oauth: { name: string; subscription: boolean } | null
  connected: 'api_key' | 'oauth' | null
}

export async function listProviders(models: Models, credentials: PgModelCredentials) {
  const connected = new Map((await credentials.list()).map((c) => [c.providerId, c.type]))
  return models.getProviders().map((p): ProviderInfo => ({
    id: p.id,
    name: p.name,
    apiKey: Boolean(p.auth.apiKey),
    oauth: p.auth.oauth
      ? { name: p.auth.oauth.name, subscription: p.auth.oauth.isSubscription === true }
      : null,
    connected: connected.get(p.id) ?? null,
  }))
}

export type LoginEvent =
  | { type: 'notify'; event: AuthEvent }
  | {
      type: 'prompt'
      prompt: Omit<AuthPrompt, 'signal'>
    }
  | { type: 'done'; warning: string | null }
  | { type: 'error'; message: string }

const LOGIN_TIMEOUT_MS = 10 * 60_000

/**
 * Connexion d'un abonnement. Le flux du fournisseur tient dans cette requête ; quand il demande
 * un code, la question est écrite dans `credential_logins` et la réponse de la personne, qui
 * arrive par une autre requête (peut-être une autre invocation sur Workers), y est relue.
 */
export async function* loginFlow(
  sql: postgres.Sql,
  userId: string,
  key: InstanceKey,
  provider: string,
  signal: AbortSignal,
): AsyncIterable<LoginEvent & { loginId?: string }> {
  const { credentials, models } = userModels(sql, userId, key)
  const target = models.getProvider(provider)
  if (!target?.auth.oauth) {
    yield {
      type: 'error',
      message: `The provider ${provider} offers no subscription sign-in.`,
    }
    return
  }
  const loginId = crypto.randomUUID()
  await sql`INSERT INTO credential_logins (id, user_id) VALUES (${loginId}, ${userId})`
  const events: (LoginEvent & { loginId?: string })[] = []
  let wake: () => void = () => {}
  const push = (event: LoginEvent & { loginId?: string }) => {
    events.push(event)
    wake()
  }
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  const login = models
    .login(provider, 'oauth', {
      signal,
      notify: (event) => push({ type: 'notify', event }),
      async prompt(prompt) {
        const { signal: promptSignal, ...shown } = prompt
        await sql`
          UPDATE credential_logins SET prompt = ${sql.json(shown as postgres.JSONValue)}, answer = NULL
          WHERE id = ${loginId}`
        push({ type: 'prompt', prompt: shown, loginId })
        while (Date.now() < deadline && !signal.aborted && !promptSignal?.aborted) {
          const [row] = await sql<{ answer: string | null }[]>`
            SELECT answer FROM credential_logins WHERE id = ${loginId}`
          if (row?.answer != null) return row.answer
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        throw new Error('Sign-in abandoned: no answer was given.')
      },
    })
    .then(
      async () => {
        const first = await credentials.markWarned(provider)
        push({
          type: 'done',
          warning: target.auth.oauth?.isSubscription && first ? SUBSCRIPTION_WARNING : null,
        })
      },
      (error: unknown) =>
        push({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => sql`DELETE FROM credential_logins WHERE id = ${loginId}`.catch(() => {}))
  try {
    for (;;) {
      while (events.length > 0) {
        const event = events.shift() as LoginEvent
        yield event
        if (event.type === 'done' || event.type === 'error') return
      }
      await new Promise<void>((resolve) => (wake = resolve))
    }
  } finally {
    await login.catch(() => {})
  }
}

export async function answerLogin(
  sql: postgres.Sql,
  userId: string,
  loginId: string,
  answer: string,
) {
  const updated = await sql`
    UPDATE credential_logins SET answer = ${answer}
    WHERE id = ${loginId} AND user_id = ${userId}`
  return updated.count > 0
}
