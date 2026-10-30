import { defineConfig } from 'vite-plus'

export default defineConfig({
  run: { cache: true },
  lint: {
    plugins: ['typescript'],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: { singleQuote: true, semi: false },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
})
