// Plateforme Cloudflare Workers : une connexion Postgres par invocation (par Hyperdrive, ou une
// adresse directe), fermée quand la réponse a fini de partir, et Cloudflare Queues pour les
// réveils. Un message de la file lance le tour suivant de sa conversation.

import { env, waitUntil } from 'cloudflare:workers'
import postgres from 'postgres'

import { chatServer, type ChatServer } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { queueScheduler, type WakeQueue } from '../server/hosting.ts'

type Env = Record<string, unknown> & {
  WAKE_QUEUE: WakeQueue
  HYPERDRIVE?: { connectionString: string }
}

/** Marge sous la limite de 15 minutes d'un consommateur de file. */
const TURN_BUDGET_MS = 10 * 60_000

function open() {
  const bindings = env as unknown as Env
  const config = readConfig(
    bindings as Record<string, string | undefined>,
    bindings.HYPERDRIVE?.connectionString ?? (bindings.DATABASE_URL as string | undefined),
  )
  const sql = postgres(config.databaseUrl, { max: 5, fetch_types: false })
  const chat = chatServer(config, sql, {
    scheduler: queueScheduler(bindings.WAKE_QUEUE),
    clientAddress: (req) => req.headers.get('cf-connecting-ip') ?? undefined,
    turnBudgetMs: TURN_BUDGET_MS,
  })
  return { chat, sql }
}

/** Le chat de cette invocation ; la connexion se ferme après le dernier octet de la réponse. */
export async function withChat(
  _req: Request,
  fn: (chat: ChatServer) => Promise<Response>,
): Promise<Response> {
  const { chat, sql } = open()
  let response: Response
  try {
    response = await fn(chat)
  } catch (error) {
    waitUntil(sql.end({ timeout: 5 }))
    throw error
  }
  if (!response.body) {
    waitUntil(sql.end({ timeout: 5 }))
    return response
  }
  let finished: () => void = () => {}
  const done = new Promise<void>((resolve) => (finished = resolve))
  const body = response.body.pipeThrough(
    new TransformStream({
      flush() {
        finished()
      },
    }),
  )
  waitUntil(done.then(() => sql.end({ timeout: 5 })))
  return new Response(body, response)
}

export const startBackground = undefined

/** Consommateur de la file des réveils. */
export const queue = async (batch: {
  messages: { body: { conversationId: string }; ack(): void; retry(): void }[]
}) => {
  const { chat, sql } = open()
  try {
    for (const message of batch.messages) {
      try {
        await chat.wake(message.body.conversationId)
        message.ack()
      } catch {
        message.retry()
      }
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
