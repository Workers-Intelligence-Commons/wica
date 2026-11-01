// Migrations of the conversation Durable Objects on Workers, generated from
// `src/server/do/schema.ts` by drizzle-kit; each Durable Object applies them to its own database
// before its first use (`src/server/do/migrations.ts`).

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/do/schema.ts',
  out: './migrations/do',
})
