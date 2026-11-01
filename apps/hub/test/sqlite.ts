// Stand-ins for the Cloudflare databases over `node:sqlite`, with only the calls the Drizzle
// drivers make: the SQLite storage of a Durable Object and a D1 database. They run the real SQL
// of the application; they do not reproduce the limits or the timing of Cloudflare.

import { DatabaseSync } from 'node:sqlite'

type Value = null | number | bigint | string | Uint8Array

function query(db: DatabaseSync, sql: string, params: unknown[]) {
  const statement = db.prepare(sql)
  statement.setReturnArrays(true)
  const rows = statement.all(...(params as Value[])) as unknown as unknown[][]
  const names = statement.columns().map((c) => c.name)
  const objects = () =>
    rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])))
  return { rows, objects }
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Storage of a Durable Object: `sql.exec` runs at once, its cursor gives the rows. */
export function durableStorage(db = new DatabaseSync(':memory:')) {
  return {
    sql: {
      exec(sql: string, ...params: unknown[]) {
        const { rows, objects } = query(db, sql, params)
        const all = objects()
        return {
          toArray: () => all,
          raw: () => ({ toArray: () => rows }),
          next: () => ({ value: all[0], done: all.length === 0 }),
        }
      },
    },
    transactionSync: <T>(fn: () => T) => transaction(db, fn),
  }
}

/** A D1 database: prepared statements bound to their values, and `batch` in one transaction. */
export function d1Database(db = new DatabaseSync(':memory:')) {
  const bound = (sql: string, params: unknown[]) => ({
    sql,
    params,
    async all() {
      return { results: query(db, sql, params).objects(), success: true, meta: {} }
    },
    async raw() {
      return query(db, sql, params).rows
    },
    async run() {
      query(db, sql, params)
      return { results: [], success: true, meta: {} }
    },
  })
  return {
    sqlite: db,
    prepare: (sql: string) => ({ bind: (...params: unknown[]) => bound(sql, params) }),
    async batch(statements: { sql: string; params: unknown[] }[]) {
      return transaction(db, () =>
        statements.map((s) => ({
          results: query(db, s.sql, s.params).objects(),
          success: true,
          meta: {},
        })),
      )
    },
  }
}

/** Applies the drizzle-kit migration files of `folder` to a D1 stand-in. */
export async function migrateD1(d1: ReturnType<typeof d1Database>, folder: URL) {
  const { readdirSync, readFileSync } = await import('node:fs')
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(new URL(file, folder), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) d1.sqlite.exec(statement)
    }
  }
}
