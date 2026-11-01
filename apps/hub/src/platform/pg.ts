// Data contracts on Postgres, assembled from one Drizzle handle, for the Node process.

import type { Scheduler } from '@wica/runtime'

import type { HubData } from '../server/app.ts'
import type { HubConfig } from '../server/config.ts'
import { instanceKey } from '../server/crypto.ts'
import { PgAccounts } from '../server/pg/accounts.ts'
import { pgAuthDatabase } from '../server/pg/auth.ts'
import { pgConversationIndex } from '../server/pg/conversations.ts'
import type { Db } from '../server/pg/db.ts'
import { pgConversationHost } from '../server/pg/host.ts'
import { pgMcpServers } from '../server/pg/mcp.ts'
import { pgSignInPrompts } from '../server/pg/prompts.ts'
import { PgSessionStore } from '../server/pg/sessions.ts'
import { pgSkills } from '../server/pg/skills.ts'
import { PgStore } from '../server/pg/store.ts'
import { pgModelCalls } from '../server/pg/model-calls.ts'
import { pgTokenRows } from '../server/pg/tokens.ts'
import { modelTokens } from '../server/tokens.ts'
import { mcpAccess } from '../server/mcp.ts'
import { conversationTurns } from '../server/turns.ts'
import { publicFetch } from './public-fetch.ts'

export function pgHubData(
  config: HubConfig,
  db: Db,
  scheduler: Scheduler,
  turnBudgetMs?: number,
): HubData {
  const key = instanceKey(config.instanceKey)
  const index = pgConversationIndex(db)
  const tokens = modelTokens(pgTokenRows(db), key)
  const mcp = pgMcpServers(db)
  const access = mcpAccess({ servers: mcp, key, publicFetch })
  const skills = pgSkills(db)
  const turns = conversationTurns({
    config,
    index,
    tokens,
    store: new PgStore(db),
    calls: pgModelCalls(db),
    sessions: new PgSessionStore(db),
    scheduler,
    mcp: access,
    skills,
    ...(turnBudgetMs !== undefined ? { turnBudgetMs } : {}),
  })
  return {
    accounts: new PgAccounts(db),
    index,
    host: pgConversationHost(db, turns),
    tokens,
    prompts: pgSignInPrompts(db),
    authDatabase: pgAuthDatabase(db),
    mcp,
    mcpAccess: access,
    skills,
  }
}
