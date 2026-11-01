// What the Worker and the conversation Durable Objects share on Cloudflare: the bindings, the
// services on D1, and the methods of a conversation's Durable Object.

import type { DurableObjectNamespace } from 'cloudflare:workers'
import type { Envelope } from '@wica/protocol'
import { drizzle } from 'drizzle-orm/d1'

import { publicOnly } from '../server/addresses.ts'
import { readConfig } from '../server/config.ts'
import { instanceKey } from '../server/crypto.ts'
import type { CommandOutcome, ConversationHost } from '../server/data.ts'
import { d1ConversationIndex } from '../server/d1/conversations.ts'
import { d1McpServers } from '../server/d1/mcp.ts'
import { D1SessionStore } from '../server/d1/sessions.ts'
import { d1Skills } from '../server/d1/skills.ts'
import { d1TokenRows } from '../server/d1/tokens.ts'
import { modelTokens } from '../server/tokens.ts'
import { mcpAccess } from '../server/mcp.ts'

/** Methods of a conversation's Durable Object, as its stub calls them. */
export interface ConversationStub {
  command(
    envelope: Envelope,
    from: { userId: string; harnessSession?: string },
  ): Promise<CommandOutcome>
  wake(conversationId: string): Promise<void>
  read(conversationId: string): ReturnType<ConversationHost['read']>
  erase(): Promise<void>
  /** Wakes the conversation after `afterMs`, at the request of another conversation's turn. */
  schedule(conversationId: string, afterMs: number): Promise<void>
  /** Opens the live socket of the conversation. */
  fetch(request: Request): Promise<Response>
}

export type CloudflareEnv = Record<string, unknown> & {
  DB: unknown
  CONVERSATIONS: DurableObjectNamespace<ConversationStub>
}

/** The Durable Object of a conversation, named by its identifier. */
export const conversationStub = (env: CloudflareEnv, conversationId: string) =>
  env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationId))

/**
 * The servers that people add are reached after the check of their address and of each
 * redirect. Workers resolves the names itself: a name is not checked after its resolution.
 */
export const publicFetch = publicOnly((input, init) => fetch(input, init))

export function cloudflareServices(env: CloudflareEnv) {
  const config = readConfig(env as Record<string, string | undefined>, 'workers')
  const db = drizzle(env.DB as never)
  const key = instanceKey(config.instanceKey)
  const mcpServers = d1McpServers(db)
  return {
    config,
    db,
    index: d1ConversationIndex(db),
    tokens: modelTokens(d1TokenRows(db), key),
    sessions: new D1SessionStore(db),
    mcpServers,
    mcpAccess: mcpAccess({ servers: mcpServers, key, publicFetch }),
    skills: d1Skills(db),
  }
}
