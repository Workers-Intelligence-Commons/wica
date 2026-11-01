// Layout of the logged-in pages: the page, the drawer of the conversations, closed on each load,
// and the settings dialog, open on the section named by `settings` in the address. The page is sent right away;
// the list arrives in its own loading boundary.

import { eq, isNull, useLiveSuspenseQuery } from '@tanstack/react-db'
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router'
import {
  Button,
  ConversationItem,
  ConversationList,
  Dialog,
  Mark,
  Skeleton,
} from '@workers-intelligence-commons/components'
import { Suspense, useEffect, useRef, useState } from 'react'

import { conversationsCollection } from '../client/collections.ts'
import { getMe, logout } from '../client/session.ts'
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
    if (!me) throw redirect({ to: '/login' })
    return { me }
  },
  component: Layout,
})

function Layout() {
  const { me } = Route.useRouteContext()
  const { settings, toolServer } = Route.useSearch()
  const navigate = useNavigate()
  const [drawer, setDrawer] = useState(false)
  // The settings load their lists once opened, and stay filled while the dialog closes.
  const [settingsShown, setSettingsShown] = useState(Boolean(settings))
  if (settings && !settingsShown) setSettingsShown(true)

  // Following a link from the drawer closes it.
  const location = useRouterState({ select: (s) => s.location })
  useEffect(() => setDrawer(false), [location.pathname])

  // The page under the dialog stays; only `settings` (and a sign-in outcome) change.
  const setSettings = (section: SettingsSection | null) => {
    const params = new URLSearchParams(location.searchStr)
    params.delete('toolServer')
    if (section) params.set('settings', section)
    else params.delete('settings')
    const query = params.toString()
    void navigate({ href: `${location.pathname}${query ? `?${query}` : ''}` })
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
          <Conversations owner={me.id} />
        </Suspense>
        <footer className="drawer-foot">
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
        </footer>
      </Dialog>
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
    </DrawerContext>
  )
}

function Conversations({ owner }: { owner: string }) {
  const { data } = useLiveSuspenseQuery({
    query: (q) =>
      q
        .from({ c: conversationsCollection })
        .where(({ c }) => eq(c.owner_id, owner))
        .where(({ c }) => isNull(c.parent_conversation_id))
        .orderBy(({ c }) => c.updated_at, 'desc'),
  })
  const params = useParams({ strict: false }) as { conversationId?: string }
  // Only the rows that appeared after the first render arrive pasted: on return, the cache shows
  // as it is.
  const initial = useRef<Set<string> | null>(null)
  initial.current ??= new Set(data.map((c) => c.id))
  return (
    <ConversationList>
      {data.map((c) => (
        <ConversationItem
          key={c.id}
          title={c.title || 'Untitled'}
          current={params.conversationId === c.id}
          entering={!initial.current?.has(c.id)}
          link={(props) => (
            <Link
              to="/c/$conversationId"
              params={{ conversationId: c.id }}
              className={props.className}
              aria-current={props['aria-current']}
            >
              {props.children}
            </Link>
          )}
        />
      ))}
    </ConversationList>
  )
}
