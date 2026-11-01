// Model of a conversation: wic-serving over Open Responses by default, or a provider hosted by
// pi-ai with the tokens the person connected. The instance tokens (environment variables, files)
// never serve the people's models.

import {
  type Api,
  type AuthContext,
  type AuthEvent,
  type AuthPrompt,
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { openResponsesModel } from '@wica/model-compat'
import { type ModelUsage, piModel } from '@wica/model-pi'
import { isLoremModel, LOREM_MODELS, loremModel, type LoremModel } from '@wica/testing/lorem'
import { REASONING_LEVELS, type ReasoningLevel } from '@wica/core'
import type { ModelAdapter } from '@wica/runtime'

import type { HubConfig } from './config.ts'
import type { SignInPrompts } from './data.ts'
import type { ModelTokens, PersonTokens } from './tokens.ts'

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
 * `conversations.model`: null for the default model, `pi:<provider>/<model>` for a hosted
 * provider, `lorem:<model>` for a fake model.
 */
export function parseModelChoice(value: string | null | undefined): ModelChoice | null {
  if (!value) return { kind: 'default' }
  const lorem = /^lorem:(.+)$/.exec(value)?.[1]
  if (lorem !== undefined) return isLoremModel(lorem) ? { kind: 'lorem', model: lorem } : null
  const match = /^pi:([^/]+)\/(.+)$/.exec(value)
  return match ? { kind: 'pi', provider: match[1] as string, model: match[2] as string } : null
}

/**
 * A model offered to the person: its `conversations.model` value, its name, the name of its
 * provider (`group`), the provider's id (`provider`, a pi-ai id for hosted models) and, for a
 * model with its own identifier, `provider/model` (`slug`).
 */
export type ModelOption = {
  id: string | null
  name: string
  group: string
  provider: string
  slug?: string
  /** Reasoning levels the model accepts, weakest first; empty for a model that does not reason. */
  levels: ReasoningLevel[]
}

/**
 * Levels of the instance's model: Open Responses has no way to say which it supports, so every
 * effort it defines is offered.
 */
export const INSTANCE_LEVELS: ReasoningLevel[] = ['off', 'low', 'medium', 'high', 'xhigh']

/** Levels of a pi-ai model, in the vocabulary of the journal. */
export function piLevels(model: Model<Api>): ReasoningLevel[] {
  if (!model.reasoning) return []
  return getSupportedThinkingLevels(model).filter((l): l is ReasoningLevel =>
    REASONING_LEVELS.includes(l as ReasoningLevel),
  )
}

const loremName = (model: LoremModel) =>
  model === 'lorem' ? 'Lorem ipsum' : 'Lorem ipsum, a tool call each turn'

/** Fake models offered when `WICA_TEST_MODELS` is active. */
export const testModelOptions = (): ModelOption[] =>
  LOREM_MODELS.map((model) => ({
    id: `lorem:${model}`,
    name: loremName(model),
    group: 'Test',
    provider: 'test',
    slug: `test/${model}`,
    levels: [],
  }))

/** No ambient source: neither an environment variable nor a file of the machine. */
const noAmbientAuth: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
}

export function userModels(tokens: ModelTokens, userId: string) {
  const credentials = tokens.forUser(userId)
  return { credentials, models: builtinModels({ credentials, authContext: noAmbientAuth }) }
}

export class NoModelError extends Error {
  override name = 'NoModelError'
}

/** Name of the chosen model, as the person sees it in the list of models. */
export function modelName(
  config: HubConfig,
  tokens: ModelTokens,
  owner: string | null,
  choice: ModelChoice,
): string {
  if (choice.kind === 'lorem') return loremName(choice.model)
  if (choice.kind === 'default') return config.model?.id ?? 'Default model'
  const found = owner
    ? userModels(tokens, owner).models.getModel(choice.provider, choice.model)
    : undefined
  return found?.name ?? choice.model
}

/** `onUsage` receives the tokens of each response, when the provider reports them. */
export function conversationModel(
  config: HubConfig,
  tokens: ModelTokens,
  owner: string | null,
  choice: ModelChoice,
  onUsage?: (usage: ModelUsage) => void,
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
      ...(onUsage ? { onUsage } : {}),
    })
  }
  if (!owner) throw new NoModelError('This conversation has no owner, so no model token applies.')
  const { credentials, models } = userModels(tokens, owner)
  return piModel({
    models,
    provider: choice.provider,
    model: choice.model,
    // The warning was shown at login; this covers a token connected another way.
    onFirstSubscriptionUse: async (provider) => void (await credentials.markWarned(provider)),
    ...(onUsage ? { onUsage } : {}),
  })
}

export type ProviderInfo = {
  id: string
  name: string
  apiKey: boolean
  oauth: { name: string; subscription: boolean } | null
  connected: 'api_key' | 'oauth' | null
}

export async function listProviders(models: Models, credentials: PersonTokens) {
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
 * Login to a subscription. The provider flow fits in this request; when it asks for a code, the
 * question is written to the sign-in prompts and the person's answer, which arrives through
 * another request (maybe another invocation on Workers), is read back from there.
 */
/**
 * Sign-in methods made for a program that does not run on the person's computer. The other
 * methods send the browser back to a fixed address on that computer, which the hub never reaches.
 */
const REMOTE_METHODS = new Set(['copy_code', 'device_code', 'device-code'])

/** The remote method, when the provider asks which sign-in method to use and offers one. */
export const remoteMethod = (prompt: AuthPrompt) =>
  prompt.type === 'select'
    ? prompt.options?.find((option) => REMOTE_METHODS.has(option.id))?.id
    : undefined

export async function* loginFlow(
  prompts: SignInPrompts,
  tokens: ModelTokens,
  userId: string,
  provider: string,
  signal: AbortSignal,
): AsyncIterable<LoginEvent & { loginId?: string }> {
  const { credentials, models } = userModels(tokens, userId)
  const target = models.getProvider(provider)
  if (!target?.auth.oauth) {
    yield {
      type: 'error',
      message: `The provider ${provider} offers no subscription sign-in.`,
    }
    return
  }
  const loginId = await prompts.open(userId)
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
        const remote = remoteMethod(prompt)
        if (remote) return remote
        const { signal: promptSignal, ...shown } = prompt
        await prompts.ask(loginId, shown)
        push({ type: 'prompt', prompt: shown, loginId })
        while (Date.now() < deadline && !signal.aborted && !promptSignal?.aborted) {
          const answer = await prompts.answer(loginId)
          if (answer != null) return answer
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
    .finally(() => prompts.close(loginId).catch(() => {}))
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
