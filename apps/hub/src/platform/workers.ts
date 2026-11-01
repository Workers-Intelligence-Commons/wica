// Cloudflare Workers platform: D1 for accounts, keys, model tokens and the list of conversations,
// and one Durable Object per conversation for its journal, its turns, its wake-ups and its live
// sockets. No Postgres and no Electric.

import { env } from 'cloudflare:workers'

import { hubServer, type HubServer } from '../server/app.ts'
import type { ConversationHost } from '../server/data.ts'
import { D1Accounts } from '../server/d1/accounts.ts'
import { d1AuthDatabase } from '../server/d1/auth.ts'
import { d1SignInPrompts } from '../server/d1/prompts.ts'
import { type CloudflareEnv, cloudflareServices, conversationStub } from './cloudflare.ts'

let instance: HubServer | null = null

function shared() {
  if (!instance) {
    const bindings = env as unknown as CloudflareEnv
    const { config, db, index, tokens, mcpServers, mcpAccess, skills } =
      cloudflareServices(bindings)
    const stub = (conversationId: string) => conversationStub(bindings, conversationId)
    const host: ConversationHost = {
      command: (envelope, from) => stub(envelope.conversationId).command(envelope, from),
      wake: (conversationId) => stub(conversationId).wake(conversationId),
      read: (conversationId) => stub(conversationId).read(conversationId),
      erase: (conversationId) => stub(conversationId).erase(),
    }
    const data = {
      accounts: new D1Accounts(db),
      index,
      host,
      tokens,
      prompts: d1SignInPrompts(db),
      authDatabase: d1AuthDatabase(db),
      mcp: mcpServers,
      mcpAccess,
      skills,
    }
    instance = hubServer(config, data, {
      clientAddress: (req) => req.headers.get('cf-connecting-ip') ?? undefined,
      live: (req, conversationId) => stub(conversationId).fetch(req),
    })
  }
  return instance
}

/** The hub of this request: the one of the isolate, over its bindings. */
export async function withHub<T>(_req: Request, fn: (hub: HubServer) => Promise<T>): Promise<T> {
  return fn(shared())
}

export const startBackground = undefined

export { ConversationObject } from './conversation-object.ts'
