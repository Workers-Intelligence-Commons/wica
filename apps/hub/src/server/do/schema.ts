// Tables of the SQLite database of one conversation's Durable Object on Workers: its journal and
// its write state. Each database holds one conversation only.

import { sql } from 'drizzle-orm'
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** The single row of the conversation: its salt and its write state. Times in milliseconds. */
export const conversation = sqliteTable('conversation', {
  id: text('id').primaryKey(),
  idSalt: text('id_salt').notNull(),
  headItemId: text('head_item_id'),
  lastSeq: integer('last_seq').notNull().default(0),
  writerEpoch: integer('writer_epoch').notNull().default(0),
  leaseUntil: integer('lease_until'),
  leaseMs: integer('lease_ms'),
  interruptRequested: integer('interrupt_requested', { mode: 'boolean' }).notNull().default(false),
})

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id'),
    seq: integer('seq').notNull().unique(),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['streaming', 'done', 'interrupted', 'failed'] }).notNull(),
    /** Full content of a large tool result; `payload` keeps only its preview, as on Postgres. */
    blob: text('blob', { mode: 'json' }),
  },
  (t) => [
    check('items_status', sql`${t.status} IN ('streaming', 'done', 'interrupted', 'failed')`),
  ],
)

export const itemChunks = sqliteTable(
  'item_chunks',
  {
    itemId: text('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.idx] })],
)

export const snapshot = sqliteTable('snapshot', {
  id: integer('id').primaryKey(),
  data: text('data', { mode: 'json' }).notNull(),
})

export const toolClaims = sqliteTable('tool_claims', {
  callId: text('call_id').primaryKey(),
  epoch: integer('epoch').notNull(),
})

/** Commands received, with their acknowledgement: a replay of the same id gets the same answer. */
export const commands = sqliteTable('commands', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  ack: text('ack', { mode: 'json' }),
})
