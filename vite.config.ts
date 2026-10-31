import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: { cache: true },
  lint: {
    ignorePatterns: ['**/routeTree.gen.ts', 'vendor/**'],
    plugins: ['typescript'],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { singleQuote: true, semi: false, ignorePatterns: ['**/routeTree.gen.ts', 'vendor/**'] },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
})
