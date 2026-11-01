// Migrations of the D1 database on Workers, generated from `src/server/d1/schema.ts` by
// drizzle-kit and applied by `wrangler d1 migrations apply`.

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/d1/schema.ts',
  out: './migrations/d1',
})
