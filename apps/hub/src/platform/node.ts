// Compose platform: a single Node process, a shared Postgres pool, the scheduler loop, which
// reads `wakeups` and starts turns in this process, and the hourly purge of the trash.

import postgres from 'postgres'

import { hubServer, type HubServer } from '../server/app.ts'
import { readConfig } from '../server/config.ts'
import { pgDatabase } from '../server/pg/db.ts'
import { pgScheduler } from '../server/pg/scheduler.ts'
import { pgHubData } from './pg.ts'
import { electricRows } from './electric.ts'

/** How often the trash and the idle guest conversations are emptied. */
const PURGE_EVERY_MS = 60 * 60_000

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
    instance = {
      hub,
      startLoop: () => {
        const stopWakeups = scheduler.run((id) => data.host.wake(id))
        const purge = () => void hub.purge().catch((e) => console.error('purge failed:', e))
        purge()
        const timer = setInterval(purge, PURGE_EVERY_MS)
        return () => {
          clearInterval(timer)
          stopWakeups()
        }
      },
    }
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

/** Workers only: Compose purges from its own loop. */
export const scheduled = undefined
