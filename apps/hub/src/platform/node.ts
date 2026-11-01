// Compose platform: a single Node process, a shared Postgres pool, and the scheduler loop, which
// reads `wakeups` and starts turns in this process.

import postgres from 'postgres'

import { hubServer, type HubServer } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { pgDatabase } from '../server/pg/db.ts'
import { pgScheduler } from '../server/pg/scheduler.ts'
import { pgHubData } from './pg.ts'
import { electricRows } from './electric.ts'

let instance: { hub: HubServer; startLoop: () => () => void } | null = null

function shared() {
  if (!instance) {
    const config = readConfig(process.env)
    const db = pgDatabase(postgres(config.storage.databaseUrl, { max: 20 }))
    const scheduler = pgScheduler(db)
    const data = pgHubData(config, db, scheduler)
    const hub = hubServer(config, data, {
      clientAddress: (req) => req.headers.get('x-wica-client-address') ?? undefined,
      rows: electricRows(config.storage),
    })
    instance = { hub, startLoop: () => scheduler.run((id) => data.host.wake(id)) }
  }
  return instance
}

/** The hub of this request: the one of the process. */
export async function withHub<T>(_req: Request, fn: (hub: HubServer) => Promise<T>): Promise<T> {
  return fn(shared().hub)
}

/** Starts the wake-up loop; returns the stop function. */
export function startBackground() {
  return shared().startLoop()
}

/** Workers only. */
export const ConversationObject = undefined
