// Compilation du chat : `WICA_TARGET=workers` produit l'application pour Cloudflare Workers,
// sinon pour Node (Compose). `#platform` suit la condition `workerd` du plugin de Cloudflare.

import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

const workers = process.env.WICA_TARGET === 'workers'

export default defineConfig({
  plugins: [
    ...(workers ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    tanstackStart(),
    viteReact(),
  ],
})
