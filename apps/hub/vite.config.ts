// Hub build: `WICA_TARGET=workers` produces the application for Cloudflare Workers, otherwise
// for Node (Compose). `#platform` follows the `workerd` condition of the Cloudflare plugin.

import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const workers = process.env.WICA_TARGET === 'workers'

export default defineConfig({
  define: { 'import.meta.env.WICA_TARGET': JSON.stringify(workers ? 'workers' : 'node') },
  plugins: [
    ...(workers ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    tanstackStart(),
    viteReact(),
  ],
})
