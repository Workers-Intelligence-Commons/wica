// Compose migration step: brings the `chat` database to the current schema, then exits. It runs
// before Electric and the application, since Electric needs its publication at startup.

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} })
try {
  await migrate(drizzle(sql), {
    migrationsFolder: new URL('../migrations/pg', import.meta.url).pathname,
  })
} finally {
  await sql.end()
}
