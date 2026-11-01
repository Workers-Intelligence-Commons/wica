// Completed model calls on Postgres: written by the turns, followed by Electric like the items.

import type { ReasoningLevel } from '@wica/core'
import { asc, eq } from 'drizzle-orm'

import type { ModelCallRow } from '../../shared/rows.ts'
import type { ModelCalls } from '../data.ts'
import type { Db } from './db.ts'
import { modelCalls } from './schema.ts'

export function pgModelCalls(db: Db): ModelCalls {
  return {
    async record(call) {
      await db
        .insert(modelCalls)
        .values({
          conversationId: call.conversation_id,
          id: call.id,
          itemIds: call.item_ids,
          model: call.model,
          modelName: call.model_name,
          startedAt: call.started_at,
          firstTokenMs: call.first_token_ms,
          durationMs: call.duration_ms,
          inputTokens: call.input_tokens,
          outputTokens: call.output_tokens,
          cacheReadTokens: call.cache_read_tokens,
          cacheWriteTokens: call.cache_write_tokens,
          reasoning: call.reasoning,
        })
        .onConflictDoNothing()
    },
  }
}

/** The calls of a conversation, oldest first, as the sync carries them. */
export async function pgCallRows(db: Db, conversationId: string): Promise<ModelCallRow[]> {
  const rows = await db
    .select()
    .from(modelCalls)
    .where(eq(modelCalls.conversationId, conversationId))
    .orderBy(asc(modelCalls.startedAt))
  return rows.map((r) => ({
    conversation_id: r.conversationId,
    id: r.id,
    item_ids: r.itemIds,
    model: r.model,
    model_name: r.modelName,
    started_at: r.startedAt,
    first_token_ms: r.firstTokenMs,
    duration_ms: r.durationMs,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_read_tokens: r.cacheReadTokens,
    cache_write_tokens: r.cacheWriteTokens,
    reasoning: r.reasoning as ReasoningLevel | null,
  }))
}
