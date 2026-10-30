// Adaptateur de modèle pour les fournisseurs hébergés, au-dessus de la bibliothèque pi-ai et
// d'elle seule. Le rendu du chemin vient
// de `codecs` ; ce paquet le traduit en messages de pi-ai, et le flux de pi-ai en `Delta`.

import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  TSchema,
} from '@earendil-works/pi-ai'
import { toTranscript, type TranscriptEntry } from '@wica/codecs'
import type { AssistantMessage, AssistantPart, ModelRequest, Part, ToolSpec } from '@wica/core'
import type { ModelAdapter, ModelChunk } from '@wica/runtime'

export type PiModelOptions = {
  /** Collection de modèles de pi-ai, créée et authentifiée par l'hôte. */
  models: Models
  /** Fournisseur et modèle au sens de pi-ai, par exemple `anthropic` et `claude-sonnet-5-5`. */
  provider: string
  model: string
  reasoning?: ThinkingLevel
  /** Options de requête de pi-ai (clé, en-têtes, réessais, durée) ; ni signal ni raisonnement. */
  request?: Omit<ModelsSimpleStreamOptions, 'signal' | 'reasoning'>
  /**
   * Appelé avant la première requête de cet adaptateur qui passe par un abonnement (connexion
   * OAuth), pour que l'hôte avertisse la personne ; l'hôte garde la trace d'un avertissement déjà
   * donné.
   */
  onFirstSubscriptionUse?: (provider: string) => void | Promise<void>
}

/** Échec du fournisseur, rendu par pi-ai. */
export class ModelError extends Error {
  override name = 'ModelError'
}

/**
 * Données opaques d'une réponse : un bloc de réflexion, ou les signatures que pi-ai attache aux
 * textes (dans leur ordre) et aux appels (par identifiant). Elles ne valent que pour le modèle qui
 * les a produites.
 */
export type PiOpaque =
  | { thinking: ThinkingContent }
  | { texts: (string | null)[]; toolCalls: Record<string, ToolCallExtra> }

type ToolCallExtra = Omit<ToolCall, 'type' | 'id' | 'name' | 'arguments' | 'argumentsError'>

type Target = Pick<Model<Api>, 'api' | 'provider' | 'id'>

/** Fournisseur inscrit dans les données opaques : l'API, le fournisseur et le modèle exacts. */
export const opaqueProvider = (model: Target) => `pi:${model.api}:${model.provider}:${model.id}`

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s

/** Une image en `data:` part en image ; un autre fichier, que pi-ai ne sait pas lire, en mention. */
function content(parts: Part[]): (TextContent | ImageContent)[] {
  return parts.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    const data = DATA_URI.exec(p.uri)
    if (data && p.mediaType.startsWith('image/')) {
      return { type: 'image', data: data[2] ?? '', mimeType: data[1] ?? p.mediaType }
    }
    return { type: 'text', text: `[Fichier ${p.mediaType} : ${p.uri}]` }
  })
}

const tool = (spec: ToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  // TypeBox décrit ses schémas en JSON Schema ordinaire, que pi-ai envoie tel quel.
  parameters: spec.inputSchema as TSchema,
})

const ZERO_USAGE: PiAssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

type AssistantEntry = Extract<
  TranscriptEntry,
  { type: 'assistant_text' | 'reasoning' | 'tool_call' }
>

/** Une suite d'entrées du modèle vers un message de pi-ai, avec les seules données opaques du modèle. */
function assistantMessage(entries: AssistantEntry[], model: Target): PiAssistantMessage {
  const own = opaqueProvider(model)
  const blocks: PiAssistantMessage['content'] = []
  let signatures: Extract<PiOpaque, { texts: unknown }> | undefined
  for (const entry of entries) {
    if (entry.type === 'assistant_text') blocks.push({ type: 'text', text: entry.text })
    else if (entry.type === 'tool_call') {
      blocks.push({
        type: 'toolCall',
        id: entry.callId,
        name: entry.tool,
        arguments:
          typeof entry.input === 'object' && entry.input !== null && !Array.isArray(entry.input)
            ? (entry.input as ToolCall['arguments'])
            : {},
      })
    } else if (entry.opaque?.provider === own) {
      const data = entry.opaque.data as PiOpaque
      if ('thinking' in data) blocks.push(data.thinking)
      else signatures = data
    }
  }
  if (signatures) {
    let text = 0
    for (const block of blocks) {
      if (block.type === 'text') {
        const signature = signatures.texts[text++]
        if (signature) block.textSignature = signature
      } else if (block.type === 'toolCall') {
        Object.assign(block, signatures.toolCalls[block.id])
      }
    }
  }
  return {
    role: 'assistant',
    content: blocks,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: blocks.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/**
 * Chemin actif vers le contexte de pi-ai. Les consignes du Harness placées dans la conversation
 * (résumé, reprise de branche, demande de résumé) partent en messages de l'utilisateur : tous les
 * fournisseurs n'acceptent pas une consigne système au milieu, et pi-ai les replierait sinon dans
 * le prompt système, loin de leur place.
 */
export function toPiContext(request: ModelRequest, model: Target): Context {
  const messages: Message[] = []
  let pending: AssistantEntry[] = []
  const flush = () => {
    if (pending.length > 0) messages.push(assistantMessage(pending, model))
    pending = []
  }
  for (const entry of toTranscript(request)) {
    switch (entry.type) {
      case 'assistant_text':
      case 'reasoning':
      case 'tool_call':
        pending.push(entry)
        break
      case 'user':
        flush()
        messages.push({ role: 'user', content: content(entry.parts), timestamp: 0 })
        break
      case 'developer':
        flush()
        messages.push({ role: 'user', content: entry.text, timestamp: 0 })
        break
      case 'tool_result':
        flush()
        messages.push({
          role: 'toolResult',
          toolCallId: entry.callId,
          toolName: entry.tool,
          content: content(entry.output),
          isError: entry.isError,
          timestamp: 0,
        })
        break
    }
  }
  flush()
  return {
    ...(request.instructions ? { systemPrompt: request.instructions } : {}),
    messages,
    ...(request.tools.length > 0 && !request.summarize ? { tools: request.tools.map(tool) } : {}),
  }
}

/** Message final de pi-ai vers celui du Harness ; les signatures vont dans une partie de raisonnement. */
export function fromPiMessage(message: PiAssistantMessage, model: Target): AssistantMessage {
  const provider = opaqueProvider(model)
  const parts: AssistantPart[] = []
  const texts: (string | null)[] = []
  const toolCalls: Record<string, ToolCallExtra> = {}
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
      texts.push(block.textSignature ?? null)
    } else if (block.type === 'thinking') {
      parts.push({
        type: 'reasoning',
        ...(block.thinking !== '' && !block.redacted ? { text: block.thinking } : {}),
        opaque: { provider, data: { thinking: block } satisfies PiOpaque },
      })
    } else {
      const { type: _type, id, name, arguments: input, argumentsError, ...extra } = block
      // Des arguments qui ne sont pas un objet JSON restent en texte : la validation de l'outil
      // rend alors un résultat d'erreur au modèle.
      parts.push({ type: 'tool_call', callId: id, tool: name, input: argumentsError ?? input })
      if (Object.keys(extra).length > 0) toolCalls[id] = extra
    }
  }
  if (texts.some((t) => t !== null) || Object.keys(toolCalls).length > 0) {
    parts.push({
      type: 'reasoning',
      opaque: { provider, data: { texts, toolCalls } satisfies PiOpaque },
    })
  }
  return { parts }
}

export function piModel(options: PiModelOptions): ModelAdapter {
  let warned = false

  const resolve = async () => {
    const model = options.models.getModel(options.provider, options.model)
    if (!model) {
      throw new ModelError(`Modèle inconnu de pi-ai : ${options.provider}/${options.model}.`)
    }
    if (options.onFirstSubscriptionUse && !warned) {
      const auth = await options.models.checkAuth(options.provider)
      if (auth?.type === 'oauth') {
        warned = true
        await options.onFirstSubscriptionUse(options.provider)
      }
    }
    return model
  }

  return {
    async *stream(request, signal): AsyncIterable<ModelChunk> {
      const model = await resolve()
      const events = options.models.streamSimple(model, toPiContext(request, model), {
        ...options.request,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        signal,
      })
      for await (const event of events) {
        switch (event.type) {
          case 'text_delta':
            if (event.delta !== '') yield { type: 'text', text: event.delta }
            break
          case 'thinking_delta':
            if (event.delta !== '') yield { type: 'reasoning', text: event.delta }
            break
          case 'done':
            yield { type: 'done', message: fromPiMessage(event.message, model) }
            return
          case 'error':
            throw new ModelError(
              event.error.errorMessage ??
                (event.reason === 'aborted'
                  ? 'Requête au modèle annulée.'
                  : 'Erreur du fournisseur.'),
            )
        }
      }
      throw new ModelError('Le flux du modèle s’est arrêté sans réponse finale.')
    },
  }
}
