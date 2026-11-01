// Browser entry point: before hydration, the account (or the guest) is known, the cache of a
// logged-out account or of another account is cleared, and the local cache files the page reads
// are opened. A guest key left in the browser, or handed over by the guest chat component on
// another site, hands its conversations to the account that signs in.

import { StartClient } from '@tanstack/react-start/client'
import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'

import { cacheName, claimCache, clearCache, touchConversation } from './client/cache.ts'
import { prepareCache, setBrowserCaches } from './client/dependencies.ts'
import { acceptHandOff, claimGuest, guestAccount, guestKey, startGuest } from './client/guest.ts'
import { loadBrowserMe } from './client/session.ts'

async function start() {
  const cleared = localStorage.getItem('wica-clear-account') !== null
  localStorage.removeItem('wica-clear-account')
  const me = await loadBrowserMe().catch(() => null)
  await acceptHandOff(me !== null).catch(() => {})
  if (me && guestKey()) await claimGuest().catch(() => {})
  const guest = me ? null : await startGuest().catch(() => null)
  const account = me?.id ?? (guest ? guestAccount(guest) : null)
  if (!account && cleared) await clearCache().catch(() => {})
  if (account) {
    await claimCache(account, cleared).catch(() => {})
    const conversation = /^\/c\/([^/]+)/.exec(location.pathname)?.[1]
    await Promise.all([
      prepareCache(cacheName(account)),
      ...(conversation
        ? [
            touchConversation(account, conversation).then(() =>
              prepareCache(cacheName(account, conversation)),
            ),
          ]
        : []),
    ])
  }
  setBrowserCaches(account ?? '')
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  )
}

void start()
