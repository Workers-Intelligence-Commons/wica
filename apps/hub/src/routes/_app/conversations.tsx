// Every conversation of the account or the guest, with a search on the titles and a selection of
// several at once: deleting puts them in the trash, or hands over to the commons the ones given to
// it. The trash restores a conversation, or erases it at once; otherwise it is erased 30 days after
// it went there.

import { and, eq, isNull, not, useLiveSuspenseQuery } from '@tanstack/react-db'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  Button,
  Dialog,
  Poster,
  SectionHeading,
  Skeleton,
} from '@workers-intelligence-commons/components'
import { Suspense, useState } from 'react'

import { conversationsCollection } from '../../client/collections.ts'
import { deleteConversation, restoreConversation } from '../../client/conversations.ts'
import type { Viewer } from '../../client/session.ts'
import type { ConversationRow } from '../../shared/rows.ts'
import { matchesTitle } from '../../ui/ConversationRows.tsx'
import { TopBar } from '../../ui/TopBar.tsx'
import { useViewer } from '../_app.tsx'

const TRASH_DAYS = 30

export const Route = createFileRoute('/_app/conversations')({ component: ConversationsPage })

function ConversationsPage() {
  const viewer = useViewer()
  return (
    <section className="conversation">
      <TopBar>All conversations</TopBar>
      <Poster className="chat-sheet manage">
        <Suspense fallback={<Skeleton lines={8} label="Loading conversations" />}>
          <Manage viewer={viewer} />
        </Suspense>
      </Poster>
    </section>
  )
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const erasedOn = (deletedAt: string) =>
  day(new Date(new Date(deletedAt).getTime() + TRASH_DAYS * 86_400_000).toISOString())

/** What deleting does when `given` of the `chosen` conversations were given to the commons. */
function givingText(given: number, chosen: number) {
  const one = given === 1
  const subject =
    given === chosen
      ? one
        ? 'This conversation was'
        : `These ${given} conversations were`
      : one
        ? 'One of them was'
        : `${given} of them were`
  const rest = chosen - given
  return [
    `${subject} given to the commons under CC0: ${one ? 'it leaves' : 'they leave'} your`,
    `conversations but ${one ? 'stays' : 'stay'} in the commons, since the dedication cannot be`,
    'withdrawn.',
    rest === 0 ? '' : rest === 1 ? 'The other goes to the trash.' : 'The others go to the trash.',
  ]
    .filter(Boolean)
    .join(' ')
}

function Manage({ viewer }: { viewer: Viewer }) {
  const [view, setView] = useState<'all' | 'trash'>('all')
  const { data } = useLiveSuspenseQuery({
    query: (q) =>
      q
        .from({ c: conversationsCollection })
        .where(({ c }) => (viewer.kind === 'user' ? eq(c.owner_id, viewer.id) : isNull(c.owner_id)))
        .where(({ c }) =>
          and(
            isNull(c.parent_conversation_id),
            view === 'all' ? isNull(c.deleted_at) : not(isNull(c.deleted_at)),
          ),
        )
        .orderBy(({ c }) => c.updated_at, 'desc'),
  })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<'give' | 'erase' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const shown = data.filter((c) => matchesTitle(c.title, search))
  const chosen = shown.filter((c) => selected.has(c.id))
  const allChosen = shown.length > 0 && chosen.length === shown.length

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  async function each(rows: ConversationRow[], act: (row: ConversationRow) => Promise<unknown>) {
    setFailed(null)
    setConfirm(null)
    const failures: string[] = []
    for (const row of rows) {
      await act(row).catch((e: unknown) =>
        failures.push(`${row.title || 'Untitled'}: ${e instanceof Error ? e.message : String(e)}`),
      )
    }
    setSelected(new Set())
    if (failures.length > 0) setFailed(failures.join('\n'))
  }

  const removeChosen = () => void each(chosen, (row) => deleteConversation(row.id))
  const given = chosen.filter((c) => c.contributed_at)

  return (
    <>
      <SectionHeading kicker={view === 'all' ? 'your conversations' : 'trash'}>
        {view === 'all' ? 'Conversations' : `Erased ${TRASH_DAYS} days after deletion`}
      </SectionHeading>
      <div className="manage-tabs" role="tablist" aria-label="Conversations or trash">
        {(['all', 'trash'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className="manage-tab wic-focus"
            onClick={() => {
              setView(v)
              setSelected(new Set())
            }}
          >
            {v === 'all' ? 'Conversations' : 'Trash'}
          </button>
        ))}
      </div>
      <div className="manage-bar">
        <input
          type="search"
          className="wic-input wic-focus"
          aria-label="Search titles"
          placeholder="Search titles"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="manage-all">
          <input
            type="checkbox"
            className="wic-check-box wic-focus"
            checked={allChosen}
            disabled={shown.length === 0}
            onChange={() => setSelected(allChosen ? new Set() : new Set(shown.map((c) => c.id)))}
          />
          Select all
        </label>
        <span className="manage-count" aria-live="polite">
          {chosen.length > 0 ? `${chosen.length} selected` : ''}
        </span>
        {view === 'all' ? (
          <Button
            variant="ink"
            disabled={chosen.length === 0}
            onClick={() => (given.length > 0 ? setConfirm('give') : removeChosen())}
          >
            Delete
          </Button>
        ) : (
          <>
            <Button
              variant="ink"
              disabled={chosen.length === 0}
              onClick={() => void each(chosen, (row) => restoreConversation(row.id))}
            >
              Restore
            </Button>
            <Button
              variant="quiet"
              disabled={chosen.length === 0}
              onClick={() => setConfirm('erase')}
            >
              Delete forever
            </Button>
          </>
        )}
      </div>
      <p className="failure manage-failure" role="alert">
        {failed}
      </p>
      {shown.length === 0 ? (
        <p className="manage-empty">
          {search
            ? 'No title matches.'
            : view === 'all'
              ? 'No conversation yet.'
              : 'The trash is empty.'}
        </p>
      ) : (
        <ul className="manage-list">
          {shown.map((c) => (
            <li key={c.id} className="manage-row">
              <input
                type="checkbox"
                className="wic-check-box wic-focus"
                aria-label={`Select ${c.title || 'Untitled'}`}
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              <Link
                to="/c/$conversationId"
                params={{ conversationId: c.id }}
                className="manage-title wic-focus"
              >
                {c.title || 'Untitled'}
              </Link>
              <span className="manage-meta">
                {c.deleted_at
                  ? `erased on ${erasedOn(c.deleted_at)}`
                  : `${c.contributed_at ? 'CC0 · ' : ''}${day(c.updated_at)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        title={confirm === 'erase' ? 'Delete forever' : 'Leave to the commons'}
        open={confirm !== null}
        onClose={() => setConfirm(null)}
      >
        {confirm === 'erase' ? (
          <p>
            {chosen.length === 1
              ? 'This conversation is'
              : `These ${chosen.length} conversations are`}{' '}
            erased now, with every message and branch. This cannot be undone.
          </p>
        ) : (
          <p>{givingText(given.length, chosen.length)}</p>
        )}
        <div className="dialog-actions">
          <Button
            variant="primary"
            onClick={() =>
              confirm === 'erase'
                ? void each(chosen, (row) => deleteConversation(row.id, true))
                : removeChosen()
            }
          >
            {confirm === 'erase' ? 'Delete forever' : 'Delete'}
          </Button>
          <Button variant="quiet" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  )
}
