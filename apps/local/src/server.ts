// The local binary's server: Harness, working folder tools, user channel tools, and the Open
// Responses model configured by the environment, or a fake model from `@wica/testing/lorem` for
// trying without a model server.

import { openResponsesModel } from '@wica/model-compat'
import {
  type Authorize,
  type ClientAuth,
  createHarness,
  type Harness,
  type HarnessOptions,
} from '@wica/runtime'
import { isLoremModel, loremModel } from '@wica/testing/lorem'
import { nodeTools } from '@wica/tools-node'
import { renderAnswer, userTools } from '@wica/tools-user'

export type LocalConfig = {
  /** Absent when `model` is a fake model (`lorem`, `lorem-tools`). */
  modelUrl?: string
  model: string
  apiKey?: string
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Folder where the tools act. */
  root: string
  /** True: every tool is allowed without a request. */
  allowAll: boolean
  auth?: ClientAuth
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const

/** Reads the model configuration from the environment. */
export function configFromEnv(
  env: NodeJS.ProcessEnv,
  rest: Omit<LocalConfig, 'modelUrl' | 'model' | 'apiKey' | 'effort'>,
): LocalConfig {
  const modelUrl = env.WICA_MODEL_URL
  const model = env.WICA_MODEL
  if (!model || (!modelUrl && !isLoremModel(model))) {
    throw new ConfigError(
      'WICA_MODEL_URL (address of the Open Responses service, for example http://localhost:8000/v1) and WICA_MODEL (model identifier) are required, except for the fake models WICA_MODEL=lorem or lorem-tools.',
    )
  }
  const effort = env.WICA_REASONING_EFFORT
  if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) {
    throw new ConfigError(`WICA_REASONING_EFFORT must be ${EFFORTS.join(', ')}.`)
  }
  return {
    ...rest,
    ...(modelUrl ? { modelUrl } : {}),
    model,
    ...(env.WICA_API_KEY ? { apiKey: env.WICA_API_KEY } : {}),
    ...(effort ? { effort: effort as NonNullable<LocalConfig['effort']> } : {}),
  }
}

/** Reads pass; everything else asks for the person's approval. */
export const askBeforeChanges: Authorize = (call) =>
  call.annotations.readOnlyHint ? 'allow' : { ask: `Allow ${call.tool}?` }

/** Tools, instructions and storage for a mode other than the command line, like ACP or the chat. */
export type ServerOverrides = Pick<HarnessOptions, 'tools' | 'instructions' | 'store'>

/** The Open Responses service when an address is given, otherwise the named fake model. */
function modelOf(config: LocalConfig) {
  if (config.modelUrl) {
    return openResponsesModel({
      baseUrl: config.modelUrl,
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.effort ? { reasoning: { effort: config.effort } } : {}),
    })
  }
  if (isLoremModel(config.model)) return loremModel(config.model)
  throw new ConfigError(`WICA_MODEL_URL is required for the model ${config.model}.`)
}

export function createLocalServer(config: LocalConfig, overrides: ServerOverrides = {}): Harness {
  return createHarness({
    model: modelOf(config),
    tools: overrides.tools ?? [...nodeTools({ roots: [config.root] }), ...userTools],
    authorize: config.allowAll ? () => 'allow' : askBeforeChanges,
    renderAnswer,
    instructions:
      overrides.instructions ??
      `You work in the folder ${config.root}. Speak to the person with the say tool, and ask your questions with ask_user.`,
    ...(config.auth ? { auth: config.auth } : {}),
    ...(overrides.store ? { store: overrides.store } : {}),
  })
}
