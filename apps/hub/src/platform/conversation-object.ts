// Durable Object of one conversation on Workers. Its SQLite database holds the journal; its turns
// run here, in the request of a command, then in its alarm, which is the scheduler of the
// conversation. The sockets of the open tabs receive each committed write, and the list in D1
// receives the head after each turn.

import { DurableObject, type DurableObjectState } from 'cloudflare:workers'
import type { Envelope } from '@wica/protocol'
import type { Scheduler } from '@wica/runtime'
import { drizzle } from 'drizzle-orm/durable-sqlite'

import type { CommandOutcome } from '../server/data.ts'
import { migrateConversation } from '../server/do/migrations.ts'
import {
  type DoDb,
  DoStore,
  journalRows,
  recordCommand,
  saveAck,
  storedConversation,
} from '../server/do/store.ts'
import { conversationTurns } from '../server/turns.ts'
import type { LiveFrame } from '../shared/live.ts'
import {
  type CloudflareEnv,
  cloudflareServices,
  type ConversationStub,
  conversationStub,
} from './cloudflare.ts'

/** Margin under the 15 minutes of an alarm. */
const TURN_BUDGET_MS = 10 * 60_000

/** Workers runtime: the two ends of a socket. */
const socketPair = () =>
  Object.values(
    new (
      globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, WebSocket> }
    ).WebSocketPair(),
  ) as [WebSocket, WebSocket]

export class ConversationObject extends DurableObject<CloudflareEnv> implements ConversationStub {
  readonly #db: DoDb
  readonly #services: ReturnType<typeof cloudflareServices>
  readonly #store: DoStore
  readonly #turns: ReturnType<typeof conversationTurns>
  #migrated: Promise<void> | null = null

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env)
    this.#db = drizzle(ctx.storage as never)
    this.#services = cloudflareServices(env)
    const { config, index, tokens, sessions, mcpAccess, skills } = this.#services
    this.#store = new DoStore(
      this.#db,
      async (conversationId) => {
        const entry = await index.get(conversationId)
        if (!entry) throw new Error(`unknown conversation: ${conversationId}`)
        return entry.salt
      },
      (frame) => this.#broadcast(frame),
    )
    const scheduler: Scheduler = {
      wake: async (conversationId, options = {}) => {
        const afterMs = options.afterMs ?? 0
        if (conversationId === storedConversation(this.#db)?.id) return this.#arm(afterMs)
        await conversationStub(this.env, conversationId).schedule(conversationId, afterMs)
      },
    }
    this.#turns = conversationTurns({
      config,
      index,
      tokens,
      store: this.#store,
      sessions,
      scheduler,
      mcp: mcpAccess,
      skills,
      turnBudgetMs: TURN_BUDGET_MS,
    })
  }

  /** Applies the migrations once per instance, and again after an erasure. */
  #ready() {
    this.#migrated ??= migrateConversation(this.#db).catch((error: unknown) => {
      this.#migrated = null
      throw error
    })
    return this.#migrated
  }

  /** One alarm per conversation: the earliest wake-up requested wins. */
  async #arm(afterMs: number) {
    const at = Date.now() + afterMs
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }

  #broadcast(frame: LiveFrame) {
    const text = JSON.stringify(frame)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text)
      } catch {
        // A socket that is closing gets the snapshot again when the tab reconnects.
      }
    }
  }

  async #recordHead(conversationId: string) {
    await this.#services.index.recordHead(
      conversationId,
      storedConversation(this.#db)?.head ?? null,
    )
  }

  async command(
    envelope: Envelope,
    from: { userId: string; harnessSession?: string },
  ): Promise<CommandOutcome> {
    await this.#ready()
    await this.#store.ensure(envelope.conversationId)
    const given = recordCommand(this.#db, envelope.commandId, envelope.command.t)
    if (given) return { kind: 'acked', ack: given }
    const { ack, sessionId } = await this.#turns.run(envelope, from)
    saveAck(this.#db, envelope.commandId, ack)
    await this.#recordHead(envelope.conversationId)
    return { kind: 'acked', ack, ...(sessionId ? { sessionId } : {}) }
  }

  async wake(conversationId: string) {
    await this.#ready()
    await this.#turns.wake(conversationId)
    await this.#recordHead(conversationId)
  }

  async alarm() {
    await this.#ready()
    const stored = storedConversation(this.#db)
    if (stored) await this.wake(stored.id)
  }

  async schedule(conversationId: string, afterMs: number) {
    await this.#ready()
    await this.#store.ensure(conversationId)
    await this.#arm(afterMs)
  }

  async read(conversationId: string) {
    await this.#ready()
    return journalRows(this.#db, conversationId)
  }

  async erase() {
    // The sockets first: erasing the storage also forgets the sockets it accepted.
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'conversation deleted')
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.#migrated = null
  }

  async fetch(request: Request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('a socket was expected', { status: 426 })
    }
    await this.#ready()
    const conversationId = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1) ?? '')
    const [client, server] = socketPair()
    // Hibernation: the Durable Object may leave memory while the socket stays open.
    this.ctx.acceptWebSocket(server)
    const snapshot: LiveFrame = { t: 'snapshot', ...journalRows(this.#db, conversationId) }
    server.send(JSON.stringify(snapshot))
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  /** The browser sends nothing on this socket. */
  webSocketMessage() {}

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason)
    } catch {
      // Already closed by the runtime.
    }
  }
}
