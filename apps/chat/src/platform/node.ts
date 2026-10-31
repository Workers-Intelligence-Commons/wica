// Compose platform: a single Node process, a shared Postgres pool, and the scheduler loop, which
// reads `wakeups` and starts turns in this process.

import postgres from 'postgres'

import { chatServer, type ChatServer } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { pgScheduler } from '../server/hosting.ts'

let instance: { chat: ChatServer; scheduler: ReturnType<typeof pgScheduler> } | null = null

function shared() {
  if (!instance) {
    const config = readConfig(process.env)
    const sql = postgres(config.databaseUrl, { max: 20 })
    const scheduler = pgScheduler(sql)
    const chat = chatServer(config, sql, {
      scheduler,
      clientAddress: (req) => req.headers.get('x-wica-client-address') ?? undefined,
    })
    instance = { chat, scheduler }
  }
  return instance
}

/** The chat of this request: the one of the process. */
export async function withChat<T>(_req: Request, fn: (chat: ChatServer) => Promise<T>): Promise<T> {
  return fn(shared().chat)
}

/** Starts the wake-up loop; returns the stop function. */
export function startBackground() {
  const { chat, scheduler } = shared()
  return scheduler.run((conversationId) => chat.wake(conversationId))
}

export const queue = undefined
