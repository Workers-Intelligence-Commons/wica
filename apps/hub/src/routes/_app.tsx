// Layout of the logged-in pages: the sidebar (conversations) and the main area. The shell is
// sent right away; the list arrives in its own loading boundary.

import { eq, isNull, useLiveSuspenseQuery } from '@tanstack/react-db'
import { createFileRoute, Link, Outlet, redirect, useParams } from '@tanstack/react-router'
import {
  Button,
  ConversationItem,
  ConversationList,
  Mark,
  Skeleton,
} from '@workers-intelligence-commons/components'
import { Suspense, useRef } from 'react'

import { conversationsCollection } from '../client/collections.ts'
import { getMe, logout } from '../client/session.ts'

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const me = await getMe()
    if (!me) throw redirect({ to: '/login' })
    return { me }
  },
  component: Layout,
})

function Layout() {
  const { me } = Route.useRouteContext()
  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <Mark name="wic" height={32} label="Workers' Intelligence Commons" />
          <Link to="/" className="wic-btn wic-focus wic-btn-primary">
            New conversation
          </Link>
        </header>
        <Suspense fallback={<Skeleton lines={6} label="Loading conversations" />}>
          <Conversations owner={me.id} />
        </Suspense>
        <footer className="sidebar-foot">
          <span className="who">{me.name}</span>
          <Link to="/settings" className="wic-btn wic-focus wic-btn-quiet">
            Settings
          </Link>
          {me.admin ? (
            <Link to="/admin" className="wic-btn wic-focus wic-btn-quiet">
              Administration
            </Link>
          ) : null}
          <Button variant="quiet" onClick={() => void logout(me.id)}>
            Sign out
          </Button>
        </footer>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
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
  // Only the rows that appeared after the first render animate: on return, the cache shows as
  // it is.
  const initial = useRef<Set<string> | null>(null)
  initial.current ??= new Set(data.map((c) => c.id))
  return (
    <ConversationList>
      {data.map((c, i) => (
        <ConversationItem
          key={c.id}
          title={c.title || 'Untitled'}
          current={params.conversationId === c.id}
          link={(props) => (
            <Link
              to="/c/$conversationId"
              params={{ conversationId: c.id }}
              className={initial.current?.has(c.id) ? props.className : `${props.className} enter`}
              style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
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
