// Migrations of a conversation's database, read from `migrations/do` when the application is
// built, and applied by the Durable Object before its first use.

import { migrate } from 'drizzle-orm/durable-sqlite/migrator'

import journal from '../../../migrations/do/meta/_journal.json'
import type { DoDb } from './store.ts'

const files = import.meta.glob<string>('../../../migrations/do/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** The files of the journal, under the keys the Drizzle migrator reads (`m0000`, `m0001`…). */
const migrations = Object.fromEntries(
  journal.entries.map((entry) => {
    const sql = files[`../../../migrations/do/${entry.tag}.sql`]
    if (sql === undefined) throw new Error(`missing migration: ${entry.tag}`)
    return [`m${String(entry.idx).padStart(4, '0')}`, sql]
  }),
)

export const migrateConversation = (db: DoDb) => migrate(db, { journal, migrations })
