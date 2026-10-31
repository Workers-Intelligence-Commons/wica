// Plateforme du Compose : un seul processus Node, un pool Postgres partagé, et la boucle du
// planificateur, qui lit `wakeups` et lance les tours dans ce processus.

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

/** Le chat de cette requête : celui du processus. */
export async function withChat<T>(_req: Request, fn: (chat: ChatServer) => Promise<T>): Promise<T> {
  return fn(shared().chat)
}

/** Démarre la boucle des réveils ; rend la fonction d'arrêt. */
export function startBackground() {
  const { chat, scheduler } = shared()
  return scheduler.run((conversationId) => chat.wake(conversationId))
}

export const queue = undefined
