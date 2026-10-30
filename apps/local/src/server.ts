// Le serveur du binaire local : Harness, outils du dossier de travail, outils du canal
// utilisateur et modèle Open Responses configuré par l'environnement.

import { openResponsesModel } from '@wica/model-compat'
import {
  type Authorize,
  type ClientAuth,
  createHarness,
  type Harness,
  type HarnessOptions,
} from '@wica/runtime'
import { nodeTools } from '@wica/tools-node'
import { renderAnswer, userTools } from '@wica/tools-user'

export type LocalConfig = {
  modelUrl: string
  model: string
  apiKey?: string
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Dossier où les outils agissent. */
  root: string
  /** Vrai : tout outil est autorisé sans demande. */
  allowAll: boolean
  auth?: ClientAuth
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const

/** Lit la configuration du modèle dans l'environnement. */
export function configFromEnv(
  env: NodeJS.ProcessEnv,
  rest: Omit<LocalConfig, 'modelUrl' | 'model' | 'apiKey' | 'effort'>,
): LocalConfig {
  const modelUrl = env.WICA_MODEL_URL
  const model = env.WICA_MODEL
  if (!modelUrl || !model) {
    throw new ConfigError(
      'WICA_MODEL_URL (adresse du service Open Responses, par exemple http://localhost:8000/v1) et WICA_MODEL (identifiant du modèle) sont requis.',
    )
  }
  const effort = env.WICA_REASONING_EFFORT
  if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) {
    throw new ConfigError(`WICA_REASONING_EFFORT doit valoir ${EFFORTS.join(', ')}.`)
  }
  return {
    ...rest,
    modelUrl,
    model,
    ...(env.WICA_API_KEY ? { apiKey: env.WICA_API_KEY } : {}),
    ...(effort ? { effort: effort as NonNullable<LocalConfig['effort']> } : {}),
  }
}

/** Les lectures passent ; tout le reste demande l'accord de la personne. */
export const askBeforeChanges: Authorize = (call) =>
  call.annotations.readOnlyHint ? 'allow' : { ask: `Autoriser ${call.tool} ?` }

/** Outils et consignes d'un autre mode que la ligne de commande, comme ACP. */
export type ServerOverrides = Pick<HarnessOptions, 'tools' | 'instructions'>

export function createLocalServer(config: LocalConfig, overrides: ServerOverrides = {}): Harness {
  return createHarness({
    model: openResponsesModel({
      baseUrl: config.modelUrl,
      model: config.model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.effort ? { reasoning: { effort: config.effort } } : {}),
    }),
    tools: overrides.tools ?? [...nodeTools({ roots: [config.root] }), ...userTools],
    authorize: config.allowAll ? () => 'allow' : askBeforeChanges,
    renderAnswer,
    instructions:
      overrides.instructions ??
      `Tu travailles dans le dossier ${config.root}. Parle à la personne avec l'outil say, et pose tes questions avec ask_user.`,
    ...(config.auth ? { auth: config.auth } : {}),
  })
}
