// Migrations of the Compose database, generated from `src/server/pg/schema.ts` by drizzle-kit.

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/pg/schema.ts',
  out: './migrations/pg',
})
