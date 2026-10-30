import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: { cache: true },
  lint: {
    plugins: ['typescript'],
    options: { typeAware: true, typeCheck: true },
  },
  // Les specs restent la copie fidèle des pages Notion : le formateur ne les réécrit pas.
  fmt: { singleQuote: true, semi: false, ignorePatterns: ['specs/**'] },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
})
