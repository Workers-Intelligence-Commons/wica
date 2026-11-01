// Layout of the pages of an account or a guest: the page, the drawer of the conversations, closed
// on each load, and the settings dialog, open on the section named by `settings` in the address.
// The page is sent right away; the list arrives in its own loading boundary. A guest's pages render
// in the browser only, where their key is: before they agree to the fingerprint, the layout shows
// the consent instead of the page.

import { and, eq, isNull, useLiveSuspenseQuery } from '@tanstack/react-db'
import {
  ClientOnly,
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import {
  Button,
  ConversationList,
  Dialog,
  Mark,
  Skeleton,
} from '@workers-intelligence-commons/components'
import { Suspense, useEffect, useState } from 'react'

import { conversationsCollection } from '../client/collections.ts'
import { guestAccount, guestConsents, guestKey, startGuest } from '../client/guest.ts'
import { getMe, getSignIn, logout, type Viewer } from '../client/session.ts'
import { GuestGate } from '../ui/Consent.tsx'
import { ConversationRows, matchesTitle } from '../ui/ConversationRows.tsx'
import { Settings, type SettingsSection, settingsSection } from '../ui/Settings.tsx'
import { DrawerContext } from '../ui/TopBar.tsx'

/**
 * `settings`: the section of the settings dialog that is open; any other value opens the account.
 * `toolServer`: the outcome of a tool server sign-in, on the return from its sign-in page.
 */
type AppSearch = { settings?: SettingsSection; toolServer?: string }

export const Route = createFileRoute('/_app')({
  validateSearch: (search): AppSearch => ({
    ...(search.settings ? { settings: settingsSection(search.settings) ?? 'account' } : {}),
    ...(typeof search.toolServer === 'string' ? { toolServer: search.toolServer } : {}),
  }),
  beforeLoad: async () => {
    const me = await getMe()
    if (me) return { me, viewer: { kind: 'user', id: me.id } as Viewer | null }
    const signIn = await getSignIn()
    if (!signIn.guests) throw redirect({ to: '/login' })
    // The guest key lives in the browser: the server sends the page without it.
    if (import.meta.env.SSR || !guestConsents().protection?.granted) {
      return { me: null, viewer: null as Viewer | null }
    }
    const key = await startGuest().catch(() => null)
    return { me: null, viewer: key ? ({ kind: 'guest', id: guestAccount(key) } as Viewer) : null }
  },
  component: Layout,
})

/** The viewer of a page under the layout, which renders its pages only once there is one. */
export function useViewer(): Viewer {
  const { viewer } = Route.useRouteContext()
  if (!viewer) throw new Error('a page rendered without an account or a guest')
  return viewer
}

function Layout() {
  const { me, viewer } = Route.useRouteContext()
  const { settings, toolServer } = Route.useSearch()
  const navigate = useNavigate()
  const router = useRouter()
  const [drawer, setDrawer] = useState(false)
  // The settings load their lists once opened, and stay filled while the dialog closes.
  const [settingsShown, setSettingsShown] = useState(Boolean(settings))
  if (settings && !settingsShown) setSettingsShown(true)

  // Following a link from the drawer closes it.
  const location = useRouterState({ select: (s) => s.location })
  useEffect(() => setDrawer(false), [location.pathname])

  // A guest who already agreed: the page from the server had no key, the browser has one.
  useEffect(() => {
    if (!viewer && guestKey() && guestConsents().protection?.granted) void router.invalidate()
  }, [viewer, router])

  // The page under the dialog stays; only `settings` (and a sign-in outcome) change.
  const setSettings = (section: SettingsSection | null) => {
    const params = new URLSearchParams(location.searchStr)
    params.delete('toolServer')
    if (section) params.set('settings', section)
    else params.delete('settings')
    const query = params.toString()
    void navigate({ href: `${location.pathname}${query ? `?${query}` : ''}` })
  }

  if (!viewer) {
    return (
      <div className="app">
        <ClientOnly fallback={<Skeleton lines={6} label="Loading" />}>
          {guestKey() && guestConsents().protection?.granted ? (
            <Skeleton lines={6} label="Loading" />
          ) : (
            <GuestGate />
          )}
        </ClientOnly>
      </div>
    )
  }

  return (
    <DrawerContext value={() => setDrawer(true)}>
      <div className="app">
        <Outlet />
      </div>
      <Dialog placement="side" title="Conversations" open={drawer} onClose={() => setDrawer(false)}>
        <div className="drawer-head">
          <Mark name="hub" height={32} label="WIC hub" />
          <Link to="/" className="wic-btn wic-focus wic-btn-primary">
            New conversation
          </Link>
        </div>
        <Suspense fallback={<Skeleton lines={6} label="Loading conversations" />}>
          <Conversations viewer={viewer} />
        </Suspense>
        <footer className="drawer-foot">
          {me ? (
            <>
              <span className="who">{me.name}</span>
              <Button
                variant="quiet"
                onClick={() => {
                  setDrawer(false)
                  setSettings('account')
                }}
              >
                Settings
              </Button>
              {me.admin ? (
                <Link to="/admin" className="wic-btn wic-focus wic-btn-quiet">
                  Administration
                </Link>
              ) : null}
              <Button variant="quiet" onClick={() => void logout(me.id)}>
                Sign out
              </Button>
            </>
          ) : (
            <>
              <span className="who">Guest</span>
              <Link to="/login" className="wic-btn wic-focus wic-btn-quiet">
                Sign in
              </Link>
              <Link to="/signup" className="wic-btn wic-focus wic-btn-quiet">
                Create an account
              </Link>
            </>
          )}
        </footer>
      </Dialog>
      {me ? (
        <Dialog title="Settings" open={Boolean(settings)} onClose={() => setSettings(null)}>
          {settingsShown ? (
            <Settings
              me={me}
              section={settings ?? 'account'}
              onSection={setSettings}
              toolServer={toolServer}
            />
          ) : null}
        </Dialog>
      ) : null}
    </DrawerContext>
  )
}

/** The conversations outside the trash, newest first, with a search on their titles. */
function Conversations({ viewer }: { viewer: Viewer }) {
  const { data } = useLiveSuspenseQuery({
    query: (q) =>
      q
        .from({ c: conversationsCollection })
        .where(({ c }) => (viewer.kind === 'user' ? eq(c.owner_id, viewer.id) : isNull(c.owner_id)))
        .where(({ c }) => and(isNull(c.parent_conversation_id), isNull(c.deleted_at)))
        .orderBy(({ c }) => c.updated_at, 'desc'),
  })
  const params = useParams({ strict: false }) as { conversationId?: string }
  const [search, setSearch] = useState('')
  const shown = data.filter((c) => matchesTitle(c.title, search))
  return (
    <>
      <input
        type="search"
        className="wic-input wic-focus drawer-search"
        aria-label="Search conversations"
        placeholder="Search titles"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ConversationList>
        <ConversationRows rows={shown} current={params.conversationId} />
        {search && shown.length === 0 ? <li className="drawer-empty">No title matches.</li> : null}
      </ConversationList>
      <Link to="/conversations" className="wic-btn wic-focus wic-btn-quiet drawer-all">
        All conversations and trash
      </Link>
    </>
  )
}
