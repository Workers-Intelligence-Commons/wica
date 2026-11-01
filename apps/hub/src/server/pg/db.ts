// Drizzle handle of the Compose database, the transaction handle the implementations share, and
// the check of the identifiers that the routes receive.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'

export type Db = PostgresJsDatabase
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** A handle that runs queries: the database, or a transaction in progress. */
export type Query = Db | Tx

export const pgDatabase = (sql: postgres.Sql): Db => drizzle(sql)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Postgres refuses an identifier that is not a UUID instead of finding no row. */
export const isUuid = (id: string) => UUID.test(id)
