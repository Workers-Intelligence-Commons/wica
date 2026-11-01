// Browser entry point: before hydration, the account is known, the cache of a logged-out account
// or of another account is cleared, and the local cache files the page reads are opened.

import { StartClient } from '@tanstack/react-start/client'
import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'

import { cacheName, claimCache, clearCache, touchConversation } from './client/cache.ts'
import { prepareCache, setBrowserCaches } from './client/dependencies.ts'
import { loadBrowserMe } from './client/session.ts'

async function start() {
  const cleared = localStorage.getItem('wica-clear-account') !== null
  localStorage.removeItem('wica-clear-account')
  const me = await loadBrowserMe().catch(() => null)
  if (!me && cleared) await clearCache().catch(() => {})
  if (me) {
    await claimCache(me.id, cleared).catch(() => {})
    const conversation = /^\/c\/([^/]+)/.exec(location.pathname)?.[1]
    await Promise.all([
      prepareCache(cacheName(me.id)),
      ...(conversation
        ? [
            touchConversation(me.id, conversation).then(() =>
              prepareCache(cacheName(me.id, conversation)),
            ),
          ]
        : []),
    ])
  }
  setBrowserCaches(me?.id ?? '')
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  )
}

void start()
