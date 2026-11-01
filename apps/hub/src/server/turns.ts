// Turns of the conversations: the Harness of a conversation, with its model, its tools and its
// storage, and the processing of one command in the request that brings it. The same on every
// platform; the platform gives the storage and the scheduler.

import {
  type Authorize,
  type ClientAuth,
  createHarness,
  isDestructive,
  isOpenWorld,
  type ModelAdapter,
  type Scheduler,
  type SessionStore,
  scheduleTools,
  type Store,
  type Tool,
} from '@wica/runtime'
import type { Envelope } from '@wica/protocol'
import type { McpConnections } from '@wica/mcp'
import { renderAnswer, userTools } from '@wica/tools-user'

import type { HubConfig } from './config.ts'
import { sign, verify } from './crypto.ts'
import type { ConversationIndex, ModelCalls, Skills } from './data.ts'
import type { ModelTokens } from './tokens.ts'
import type { McpAccess } from './mcp.ts'
import { measuredModel } from './model-calls.ts'
import { conversationModel, modelName, parseModelChoice } from './models.ts'
import { oneShot } from './one-shot.ts'
import { CREATE_SKILL_TOOL, createSkillQuestion, createSkillTool, turnSkills } from './skills.ts'

const INSTRUCTIONS =
  'You are the assistant of a chat. Answer the person in the conversation, and ask your questions with ask_user. You have no access to the file system or to a terminal.'

/**
 * The server has only tools without system access: they pass without a request, except a skill,
 * which the person reads before it is saved.
 */
export const hubAuthorize: Authorize = (call) => {
  if (call.tool === CREATE_SKILL_TOOL) return { ask: createSkillQuestion(call.input) }
  return !isDestructive(call.annotations) && !isOpenWorld(call.annotations)
    ? 'allow'
    : { ask: `Allow ${call.tool}?` }
}

const COMMAND_TOKEN_MS = 60_000

/** A model that cannot be found does not stop the command from being written; the long turn reports it. */
const unavailableModel = (message: string): ModelAdapter => ({
  stream: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(message)) }),
  }),
})

export type TurnDeps = {
  config: HubConfig
  index: ConversationIndex
  tokens: ModelTokens
  store: Store
  /** Where the measures of the completed model calls go. */
  calls: ModelCalls
  sessions: SessionStore
  scheduler: Scheduler
  /** Tool servers of the conversation owner, connected for each wake-up. */
  mcp: McpAccess
  /** Skills that the conversation owner sees, read at each wake-up. */
  skills: Skills
  /** Budget of a turn before handing back control and asking for a resume. */
  turnBudgetMs?: number
}

export function conversationTurns(deps: TurnDeps) {
  const { config, index } = deps

  /** The Harness recognizes the short token that a command request gives it. */
  const clientAuth: ClientAuth = {
    async authenticate({ token }) {
      const claims = token
        ? await verify<{ uid: string; exp: number; purpose: string }>(config.sessionSecret, token)
        : null
      if (!claims || claims.purpose !== 'command' || claims.exp < Date.now()) return null
      return {
        identity: { userId: claims.uid },
        from: { channel: 'web', author: claims.uid, trust: 'owner' },
      }
    },
    // A guest acts as `guest:` and their key, on the conversations of the key that no account owns.
    async canAccess(identity, conversationId) {
      const userId = (identity as { userId?: string }).userId
      const entry = await index.get(conversationId)
      if (!userId || !entry) return false
      if (userId.startsWith('guest:')) {
        return entry.ownerId === null && entry.guestId === userId.slice('guest:'.length)
      }
      return entry.ownerId === userId
    },
  }

  const ownTools = [...userTools, ...scheduleTools]

  async function harnessFor(
    conversationId: string,
    turn: {
      tools: (conversationId: string) => Promise<Tool[]>
      skills: ReturnType<typeof turnSkills>
    } | null = null,
  ) {
    const entry = await index.get(conversationId)
    const choice = parseModelChoice(entry?.model)
    let model: ModelAdapter
    try {
      if (!choice) throw new Error(`Unknown model: ${entry?.model}`)
      const owner = entry?.ownerId ?? null
      model = measuredModel({
        conversationId,
        model: entry?.model ?? null,
        modelName: modelName(config, deps.tokens, owner, choice),
        adapter: (onUsage) => conversationModel(config, deps.tokens, owner, choice, onUsage),
        store: deps.store,
        calls: deps.calls,
      })
    } catch (e) {
      model = unavailableModel(e instanceof Error ? e.message : String(e))
    }
    return createHarness({
      model,
      store: deps.store,
      sessions: deps.sessions,
      scheduler: deps.scheduler,
      auth: clientAuth,
      tools: turn?.tools ?? ownTools,
      ...(turn ? { skills: turn.skills } : {}),
      authorize: hubAuthorize,
      renderAnswer,
      instructions: INSTRUCTIONS,
      onTurnFailed: (id, message) => console.error(`turn failed in conversation ${id}: ${message}`),
      ...(deps.turnBudgetMs !== undefined ? { turnBudgetMs: deps.turnBudgetMs } : {}),
    })
  }

  /** Processes one command with a short turn; the rest of the turn leaves as a wake-up. */
  async function run(envelope: Envelope, from: { userId: string; harnessSession?: string }) {
    const token = await sign(config.sessionSecret, {
      uid: from.userId,
      exp: Date.now() + COMMAND_TOKEN_MS,
      purpose: 'command',
    })
    const { transport, result } = oneShot(
      { token, ...(from.harnessSession ? { sessionId: from.harnessSession } : {}) },
      envelope,
    )
    const harness = await harnessFor(envelope.conversationId)
    void harness.serve(transport)
    const { ack, sessionId } = await result
    return {
      ack: ack.ok ? ({ ok: true } as const) : ({ ok: false, error: ack.error } as const),
      sessionId,
    }
  }

  /**
   * Scheduled wake-up of a conversation: its next turn, with the owner's skills and tool servers.
   * The servers connect when the turn asks for its tools, and close after the wake-up.
   */
  async function wake(conversationId: string) {
    const entry = await index.get(conversationId)
    if (!entry) return
    const ownerId = entry.ownerId
    if (!ownerId) return (await harnessFor(conversationId)).wake(conversationId)
    let servers = null as Promise<McpConnections> | null
    const tools = async () => {
      servers ??= deps.mcp.connect(ownerId)
      return [...ownTools, createSkillTool(deps.skills, ownerId), ...(await servers).tools()]
    }
    const skills = turnSkills(await deps.skills.visible(ownerId))
    try {
      await (await harnessFor(conversationId, { tools, skills })).wake(conversationId)
    } finally {
      await (await servers?.catch(() => null))?.close()
    }
  }

  return { run, wake }
}

export type ConversationTurns = ReturnType<typeof conversationTurns>
