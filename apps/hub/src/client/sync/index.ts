// Browser sync source of the build target: Electric shapes on Compose, the conversation sockets
// and the polled list on Workers. The collections and the commands use only these exports.

import type { CollectionConfig } from '@tanstack/react-db'

import type { ShapeTable } from '../../shared/rows.ts'
import * as electric from './electric.ts'
import * as workers from './workers.ts'

const onWorkers = import.meta.env.WICA_TARGET === 'workers'

type Row = Record<string, unknown>
type SyncParams<T extends Row> = Parameters<CollectionConfig<T, string>['sync']['sync']>[0]

/** Applies one batch of rows as a sync transaction. */
function applier<T extends Row>(params: SyncParams<T>) {
  return (batch: workers.RowBatch<T>) => {
    if ('snapshot' in batch) {
      params.begin({ snapshot: true })
      for (const value of batch.snapshot) params.write({ type: 'insert', value })
      void params.commit()
      params.markReady()
      return
    }
    params.begin()
    for (const change of batch.changes) params.write(change)
    void params.commit()
  }
}

function workersSync<T extends Row>(table: ShapeTable, conversationId?: string) {
  return {
    sync: (params: SyncParams<T>) => {
      // The table decides the row type; the applier writes whatever rows its table gets.
      const apply = applier(params) as unknown as (batch: workers.RowBatch<unknown>) => void
      if (table === 'conversations') return workers.followList(apply, params.reportError)
      if (!conversationId) throw new Error(`${table} needs a conversation`)
      return table === 'items'
        ? workers.followItems(conversationId, apply)
        : workers.followChunks(conversationId, apply)
    },
  }
}

/** Sync options of a browser collection: its source, its key and its lifetime once unused. */
export function collectionSync<T extends Row>(options: {
  id: string
  getKey: (row: T) => string
  table: ShapeTable
  conversationId?: string
  gcTime?: number
}): CollectionConfig<T, string> {
  if (!onWorkers) return electric.electricSync<T>(options) as CollectionConfig<T, string>
  return {
    id: options.id,
    getKey: options.getKey,
    ...(options.gcTime !== undefined ? { gcTime: options.gcTime } : {}),
    sync: workersSync<T>(options.table, options.conversationId),
  }
}

/**
 * Wait for the item written by the server, for the items collection of `conversationId`;
 * `null` when that collection has no sync.
 */
export const rowConfirmation = (
  collection: { utils: Record<string, unknown> },
  conversationId: string,
) => (onWorkers ? workers.rowConfirmation(conversationId) : electric.rowConfirmation(collection))

/** Waits until a conversation just created is in the list collection. */
export const awaitCreated = onWorkers ? workers.awaitCreated : electric.awaitCreated

/** Reads the list again after an action of this tab, where the sync does not follow it. */
export const refreshList = onWorkers ? workers.refreshList : electric.refreshList
