// Adaptateur ACP : un éditeur pilote le Harness par
// l'Agent Client Protocol. L'adaptateur est un client du protocole Wica, comme le web et la
// ligne de commande : il envoie les messages de l'éditeur, lui rend le flux de la conversation,
// lui pose les questions et les approbations, et exécute pour le serveur les outils que l'éditeur
// fournit (ses fichiers et son terminal), déclarés `runsOn: 'client'`.

import * as acp from '@agentclientprotocol/sdk'
import type { Client, ConversationView } from '@wica/client'
import { APPROVAL_TOOL, ELICIT_TOOL, type Item, type Part, type ToolSpec } from '@wica/core'
import type { ClientToolResult } from '@wica/protocol'
import {
  ASK_USER_TOOL,
  type AskUserAnswer,
  type AskUserInput,
  type ElicitAnswer,
} from '@wica/tools-user'

type Call = Extract<Item, { kind: 'tool_call' }>

export const READ_TEXT_FILE_TOOL = 'read_text_file'
export const WRITE_TEXT_FILE_TOOL = 'write_text_file'
export const RUN_COMMAND_TOOL = 'run_command'

/** Ce que l'éditeur fournit comme outils, d'après ses capacités annoncées à `initialize`. */
export type EditorCapabilities = {
  readTextFile: boolean
  writeTextFile: boolean
  terminal: boolean
  /** L'éditeur sait poser un formulaire, ou ouvrir une adresse, à la personne. */
  forms: boolean
  urls: boolean
}

const editorToolSpecs: Record<string, ToolSpec> = {
  [READ_TEXT_FILE_TOOL]: {
    name: READ_TEXT_FILE_TOOL,
    description:
      'Lit un fichier texte ouvert dans l’éditeur, y compris ses modifications non enregistrées.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin absolu, ou relatif au dossier de travail.' },
        line: { type: 'integer', minimum: 1, description: 'Première ligne lue.' },
        limit: { type: 'integer', minimum: 1, description: 'Nombre de lignes lues.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    channel: 'environment',
    runsOn: 'client',
  },
  [WRITE_TEXT_FILE_TOOL]: {
    name: WRITE_TEXT_FILE_TOOL,
    description: 'Écrit un fichier texte par l’éditeur, qui montre la modification.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin absolu, ou relatif au dossier de travail.' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    channel: 'environment',
    runsOn: 'client',
  },
  [RUN_COMMAND_TOOL]: {
    name: RUN_COMMAND_TOOL,
    description: 'Lance une commande dans un terminal de l’éditeur et rend sa sortie.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string', description: 'Dossier absolu ; le dossier de travail par défaut.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    channel: 'environment',
    runsOn: 'client',
  },
}

/** Outils que le serveur déclare pour une session de cet éditeur ; il ne les exécute pas. */
export function editorTools(capabilities: EditorCapabilities): { spec: ToolSpec }[] {
  return [
    ...(capabilities.readTextFile ? [READ_TEXT_FILE_TOOL] : []),
    ...(capabilities.writeTextFile ? [WRITE_TEXT_FILE_TOOL] : []),
    ...(capabilities.terminal ? [RUN_COMMAND_TOOL] : []),
  ].map((name) => ({ spec: editorToolSpecs[name]! }))
}

/** Une session de l'éditeur, liée à une conversation du serveur. */
export type AcpSession = {
  conversationId: string
  cwd: string
  mcpServers: acp.McpServer[]
  capabilities: EditorCapabilities
}

export type AcpOptions = {
  /** Client du protocole Wica, déjà connecté au serveur. */
  client: Client
  agentInfo?: { name: string; version: string }
  /**
   * Une session s'ouvre ou se recharge : l'hôte y prépare les outils de la conversation
   * (`editorTools`, serveurs MCP de l'éditeur).
   */
  onSession?: (session: AcpSession) => void | Promise<void>
  /** Transports MCP que l'hôte sait ouvrir pour les serveurs fournis par l'éditeur. */
  mcpCapabilities?: { http?: boolean; sse?: boolean }
}

/** Contenu d'un message de l'éditeur vers les parties du journal. */
export function toParts(blocks: acp.ContentBlock[]): Part[] {
  return blocks.flatMap((block): Part[] => {
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text }]
      case 'resource_link':
        return [{ type: 'text', text: `Ressource : ${block.name} (${block.uri})` }]
      case 'resource': {
        const resource = block.resource as { uri: string; text?: string }
        return resource.text !== undefined
          ? [{ type: 'text', text: `Contenu de ${resource.uri} :\n${resource.text}` }]
          : [{ type: 'text', text: `Ressource : ${resource.uri}` }]
      }
      default:
        return []
    }
  })
}

const textOf = (parts: readonly Part[]) =>
  parts.map((p) => (p.type === 'text' ? p.text : `[fichier ${p.mediaType}]`)).join('\n')

const toolKind = (call: Call): acp.ToolKind => {
  if (call.tool === READ_TEXT_FILE_TOOL) return 'read'
  if (call.tool === WRITE_TEXT_FILE_TOOL) return 'edit'
  if (call.tool === RUN_COMMAND_TOOL) return 'execute'
  return 'other'
}

const toolTitle = (call: Call) => {
  const input = JSON.stringify(call.input ?? {})
  return `${call.tool} ${input.length > 80 ? `${input.slice(0, 77)}...` : input}`
}

const STATUS: Record<'running' | 'awaiting_approval' | 'done' | 'error', acp.ToolCallStatus> = {
  running: 'in_progress',
  awaiting_approval: 'pending',
  done: 'completed',
  error: 'failed',
}

type SessionState = AcpSession & {
  cancelled: boolean
  /** Ce qui a déjà été montré à l'éditeur : texte par élément, état par appel. */
  shownText: Map<string, number>
  shownTools: Map<string, acp.ToolCallStatus>
  /** Questions posées et appels exécutés, pour ne rien faire deux fois. */
  handled: Set<string>
  inFlight: number
}

/** Une valeur reçue de l'éditeur ou du modèle, lue comme texte. */
const stringOf = (value: unknown) =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)

const absolute = (cwd: string, path: string) =>
  path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`

/** Agent ACP qui pilote le Harness par un client du protocole Wica. */
export function acpAgent(options: AcpOptions): acp.AgentApp {
  const { client } = options
  const sessions = new Map<string, SessionState>()
  let capabilities: EditorCapabilities = {
    readTextFile: false,
    writeTextFile: false,
    terminal: false,
    forms: false,
    urls: false,
  }

  /** Les notifications partent dans l'ordre où la conversation avance. */
  let chain: Promise<unknown> = Promise.resolve()
  const notify = (editor: acp.AgentContext, sessionId: string, update: acp.SessionUpdate) => {
    chain = chain.then(() => editor.notify('session/update', { sessionId, update })).catch(() => {})
  }

  /** Montre ce qui a changé dans la conversation depuis la dernière fois. */
  const report = (
    editor: acp.AgentContext,
    session: SessionState,
    view: ConversationView,
    replay: boolean,
  ) => {
    const id = session.conversationId
    for (const entry of view.entries) {
      if (entry.type === 'user') {
        // Pendant un tour, le message vient de l'éditeur lui-même : il n'est pas renvoyé.
        if (session.shownText.has(entry.item.id)) continue
        session.shownText.set(entry.item.id, 1)
        if (!replay) continue
        for (const part of entry.item.parts) {
          if (part.type === 'text') {
            notify(editor, id, {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: part.text },
            })
          }
        }
      } else if (entry.type === 'assistant' || entry.type === 'say') {
        const key = entry.type === 'assistant' ? entry.item.id : entry.call.id
        const shown = session.shownText.get(key) ?? 0
        const text = entry.type === 'say' ? `${entry.text}\n` : entry.text
        if (text.length <= shown) continue
        session.shownText.set(key, text.length)
        notify(editor, id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: text.slice(shown) },
        })
      } else if (entry.type === 'tool') {
        const status = STATUS[entry.state]
        const before = session.shownTools.get(entry.call.callId)
        if (before === status) continue
        session.shownTools.set(entry.call.callId, status)
        const content: acp.ToolCallContent[] = entry.result
          ? [{ type: 'content', content: { type: 'text', text: textOf(entry.result.output) } }]
          : []
        if (before === undefined) {
          notify(editor, id, {
            sessionUpdate: 'tool_call',
            toolCallId: entry.call.callId,
            title: toolTitle(entry.call),
            kind: toolKind(entry.call),
            status,
            rawInput: entry.call.input,
            ...(content.length > 0 ? { content } : {}),
          })
        } else {
          notify(editor, id, {
            sessionUpdate: 'tool_call_update',
            toolCallId: entry.call.callId,
            status,
            ...(content.length > 0 ? { content } : {}),
          })
        }
      }
    }
  }

  const permission = async (
    editor: acp.AgentContext,
    session: SessionState,
    toolCallId: string,
    title: string,
    choices: acp.PermissionOption[],
  ): Promise<string | null> => {
    const request: acp.RequestPermissionRequest = {
      sessionId: session.conversationId,
      toolCall: { toolCallId, title },
      options: choices,
    }
    const response = await editor.request('session/request_permission', request)
    return response.outcome.outcome === 'selected' ? response.outcome.optionId : null
  }

  const form = (
    editor: acp.AgentContext,
    session: SessionState,
    message: string,
    requestedSchema: unknown,
  ) =>
    editor.request('elicitation/create', {
      mode: 'form',
      sessionId: session.conversationId,
      message,
      requestedSchema: requestedSchema as acp.ElicitationSchema,
    }) as Promise<{ action: string; content?: Record<string, unknown> | null }>

  const askUser = async (
    editor: acp.AgentContext,
    session: SessionState,
    call: Call,
  ): Promise<AskUserAnswer> => {
    const input = call.input as AskUserInput
    if (input.kind === 'confirm') {
      const choice = await permission(editor, session, call.callId, input.question, [
        { optionId: 'yes', name: 'Oui', kind: 'allow_once' },
        { optionId: 'no', name: 'Non', kind: 'reject_once' },
      ])
      return { kind: 'confirm', yes: choice === 'yes' }
    }
    if (input.kind === 'choice' && !capabilities.forms) {
      const choice = await permission(
        editor,
        session,
        call.callId,
        input.question,
        input.options.map((o, i) => ({ optionId: String(i), name: o.label, kind: 'allow_once' })),
      )
      const picked = choice === null ? undefined : input.options[Number(choice)]
      return picked
        ? { kind: 'choice', label: picked.label }
        : { kind: 'text', text: 'Je préfère ne pas répondre.' }
    }
    if (!capabilities.forms) {
      // L'éditeur ne sait pas poser cette question : la réponse le dit, sans rien inventer.
      return { kind: 'text', text: 'Je ne peux pas répondre à cette question depuis l’éditeur.' }
    }
    const labels = 'options' in input ? input.options.map((o) => o.label) : []
    const schema =
      input.kind === 'form'
        ? {
            type: 'object',
            properties: Object.fromEntries(
              input.fields.map((f) => [
                f.name,
                f.type === 'choice'
                  ? { type: 'string', title: f.label, enum: f.options ?? [] }
                  : { type: f.type, title: f.label },
              ]),
            ),
            required: input.fields.filter((f) => f.required).map((f) => f.name),
          }
        : {
            type: 'object',
            properties: {
              answer:
                input.kind === 'choice'
                  ? { type: 'string', enum: labels }
                  : input.kind === 'multiple'
                    ? { type: 'array', items: { type: 'string', enum: labels } }
                    : { type: 'string' },
            },
            required: ['answer'],
          }
    const response = await form(editor, session, input.question, schema)
    const content = response.content ?? {}
    if (response.action !== 'accept') return { kind: 'text', text: 'Je préfère ne pas répondre.' }
    switch (input.kind) {
      case 'choice':
        return { kind: 'choice', label: stringOf(content['answer']) }
      case 'multiple':
        return {
          kind: 'multiple',
          labels: Array.isArray(content['answer']) ? content['answer'].map(String) : [],
        }
      case 'text':
        return { kind: 'text', text: stringOf(content['answer']) }
      case 'form':
        return {
          kind: 'form',
          values: Object.fromEntries(
            Object.entries(content).filter((e): e is [string, string | number | boolean] =>
              ['string', 'number', 'boolean'].includes(typeof e[1]),
            ),
          ),
        }
    }
  }

  const elicit = async (
    editor: acp.AgentContext,
    session: SessionState,
    call: Call,
  ): Promise<ElicitAnswer> => {
    const input = call.input as {
      server: string
      message: string
      mode?: 'form' | 'url'
      url?: string
      requestedSchema?: unknown
    }
    const message = `[${input.server}] ${input.message}`
    if (input.mode === 'url') {
      if (!capabilities.urls || !input.url) return { action: 'decline' }
      const response = (await editor.request('elicitation/create', {
        mode: 'url',
        sessionId: session.conversationId,
        message,
        url: input.url,
        elicitationId: crypto.randomUUID(),
      })) as { action: string }
      return { action: response.action === 'accept' ? 'accept' : 'decline' }
    }
    if (!capabilities.forms) return { action: 'decline' }
    const response = await form(editor, session, message, input.requestedSchema ?? {})
    if (response.action === 'accept') {
      return {
        action: 'accept',
        content: (response.content ?? {}) as NonNullable<ElicitAnswer['content']>,
      }
    }
    return { action: response.action === 'cancel' ? 'cancel' : 'decline' }
  }

  /** Répond à une question du canal utilisateur par une demande de l'éditeur. */
  const answerQuestion = async (editor: acp.AgentContext, session: SessionState, call: Call) => {
    const id = session.conversationId
    if (call.tool === APPROVAL_TOOL) {
      const input = call.input as { callId: string; question: string }
      const choice = await permission(editor, session, input.callId, input.question, [
        { optionId: 'allow', name: 'Autoriser', kind: 'allow_once' },
        { optionId: 'reject', name: 'Refuser', kind: 'reject_once' },
      ])
      return client.answer(id, call.callId, choice === 'allow')
    }
    if (call.tool === ASK_USER_TOOL)
      return client.answer(id, call.callId, await askUser(editor, session, call))
    if (call.tool === ELICIT_TOOL)
      return client.answer(id, call.callId, await elicit(editor, session, call))
  }

  /** Exécute pour le serveur un outil fourni par l'éditeur. */
  const runForServer = async (
    editor: acp.AgentContext,
    session: SessionState,
    call: Call,
  ): Promise<ClientToolResult> => {
    const sessionId = session.conversationId
    const input = (call.input ?? {}) as Record<string, unknown>
    try {
      if (call.tool === READ_TEXT_FILE_TOOL) {
        const { content } = await editor.request('fs/read_text_file', {
          sessionId,
          path: absolute(session.cwd, String(input['path'])),
          ...(typeof input['line'] === 'number' ? { line: input['line'] } : {}),
          ...(typeof input['limit'] === 'number' ? { limit: input['limit'] } : {}),
        })
        return { output: [{ type: 'text', text: content }] }
      }
      if (call.tool === WRITE_TEXT_FILE_TOOL) {
        const path = absolute(session.cwd, String(input['path']))
        await editor.request('fs/write_text_file', {
          sessionId,
          path,
          content: stringOf(input['content']),
        })
        return { output: [{ type: 'text', text: `Écrit : ${path}` }] }
      }
      if (call.tool === RUN_COMMAND_TOOL) {
        const terminal = await editor.createTerminal({
          sessionId,
          command: String(input['command']),
          args: Array.isArray(input['args']) ? input['args'].map(String) : [],
          cwd: typeof input['cwd'] === 'string' ? absolute(session.cwd, input['cwd']) : session.cwd,
        })
        try {
          const exit = await terminal.waitForExit()
          const { output } = await terminal.currentOutput()
          const code = exit.exitCode ?? null
          return {
            output: [
              { type: 'text', text: `${output}\n[code de sortie : ${code ?? exit.signal}]` },
            ],
            ...(code === 0 ? {} : { isError: true }),
          }
        } finally {
          await terminal.release()
        }
      }
      return {
        output: [{ type: 'text', text: `Outil inconnu de l’éditeur : ${call.tool}` }],
        isError: true,
      }
    } catch (error) {
      return {
        output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  }

  /**
   * Lance une fois chaque question et chaque outil confié, et compte ce qui est en cours. Une
   * demande ne part qu'après les notifications qui la précèdent, pour que l'éditeur connaisse
   * déjà l'appel dont elle parle. Un échec termine le tour de l'éditeur avec son erreur.
   */
  const act = (
    editor: acp.AgentContext,
    session: SessionState,
    view: ConversationView,
    settled: (error?: unknown) => void,
  ) => {
    const start = (call: Call, job: () => Promise<unknown>) => {
      if (session.handled.has(call.callId)) return
      session.handled.add(call.callId)
      session.inFlight += 1
      void chain.then(job).then(
        () => ((session.inFlight -= 1), settled()),
        (error: unknown) => ((session.inFlight -= 1), settled(error)),
      )
    }
    for (const call of view.waiting) start(call, () => answerQuestion(editor, session, call))
    for (const call of view.clientCalls) {
      start(call, async () =>
        client.answer(
          session.conversationId,
          call.callId,
          await runForServer(editor, session, call),
        ),
      )
    }
  }

  const open = async (
    sessionId: string,
    params: { cwd: string; mcpServers: acp.McpServer[] },
  ): Promise<SessionState> => {
    const session: SessionState = {
      conversationId: sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      capabilities,
      cancelled: false,
      shownText: new Map(),
      shownTools: new Map(),
      handled: new Set(),
      inFlight: 0,
    }
    sessions.set(sessionId, session)
    await options.onSession?.({
      conversationId: sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      capabilities,
    })
    await client.subscribe(sessionId)
    return session
  }

  const sessionOf = (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) throw new acp.RequestError(-32602, `session inconnue : ${sessionId}`)
    return session
  }

  return acp
    .agent({ name: options.agentInfo?.name ?? 'wica' })
    .onRequest('initialize', ({ params }) => {
      const c = params.clientCapabilities
      capabilities = {
        readTextFile: c?.fs?.readTextFile === true,
        writeTextFile: c?.fs?.writeTextFile === true,
        terminal: c?.terminal === true,
        forms: c?.elicitation?.form != null,
        urls: c?.elicitation?.url != null,
      }
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: options.mcpCapabilities ?? {},
        },
        agentInfo: options.agentInfo ?? { name: 'wica', version: '0.0.0' },
        authMethods: [],
      }
    })
    .onRequest('session/new', async ({ params }) => {
      const sessionId = crypto.randomUUID()
      await open(sessionId, params)
      return { sessionId }
    })
    .onRequest('session/load', async ({ params, client: editor }) => {
      const session = await open(params.sessionId, params)
      // L'historique est rejoué à l'éditeur, puis la session reprend comme une nouvelle.
      report(editor, session, client.view(session.conversationId), true)
      await chain
      return {}
    })
    .onRequest('session/prompt', async ({ params, client: editor }) => {
      const session = sessionOf(params.sessionId)
      const id = session.conversationId
      session.cancelled = false
      // Ce qui précède ce message est déjà connu de l'éditeur.
      report(editor, session, client.view(id), true)
      await chain
      await client.send(id, toParts(params.prompt))
      return new Promise<acp.PromptResponse>((resolve, reject) => {
        let sawRunning = false
        let finished = false
        const finish = (outcome: () => void) => {
          if (finished) return
          finished = true
          off()
          void chain.then(outcome)
        }
        const check = (error?: unknown) => {
          if (finished) return
          if (error !== undefined) {
            const message = error instanceof Error ? error.message : stringOf(error)
            return finish(() => reject(new acp.RequestError(-32603, message)))
          }
          const view = client.view(id)
          if (view.running) sawRunning = true
          report(editor, session, view, false)
          act(editor, session, view, check)
          // Entre deux tours d'un même message (après un résultat ou une approbation), le serveur
          // ne tourne plus mais le journal attend encore sa suite : seul le repos du journal, ou
          // une erreur du tour, termine le message de l'éditeur.
          const idle =
            sawRunning &&
            !view.running &&
            session.inFlight === 0 &&
            (view.settled || view.error !== undefined)
          if (!idle) return
          finish(() => {
            if (session.cancelled) resolve({ stopReason: 'cancelled' })
            else if (view.error) reject(new acp.RequestError(-32603, view.error))
            else resolve({ stopReason: 'end_turn' })
          })
        }
        const off = client.onChange(id, () => check())
        check()
      })
    })
    .onNotification('session/cancel', async ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (!session) return
      session.cancelled = true
      await client.interrupt(session.conversationId)
    })
}
