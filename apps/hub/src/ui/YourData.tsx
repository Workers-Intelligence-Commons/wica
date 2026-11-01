// What the hub keeps for the account, and what the person can do with it: the conversations
// given to the commons, the download of everything as one JSON file, the answers to the kinds of
// consent that concern accounts, and the deletion of the account after a recent sign-in.

import { and, eq, isNull, not, useLiveSuspenseQuery } from '@tanstack/react-db'
import { Button, SectionHeading, Skeleton, Switch } from '@workers-intelligence-commons/components'
import { Suspense, useEffect, useState } from 'react'

import { conversationsCollection } from '../client/collections.ts'
import { signInAgain } from '../client/session.ts'
import type { ConsentKind } from '../shared/consent.ts'
import { FRESH_SIGN_IN_MS, type Me } from '../shared/session.ts'

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function YourData({ me }: { me: Me }) {
  return (
    <section className="panel">
      <SectionHeading level={3} kicker="what the hub keeps">
        Your data
      </SectionHeading>
      <h4 className="panel-sub">Download</h4>
      <p>
        One JSON file with your account, every conversation with its messages and model calls, your
        skills, the names of your keys, tool servers and model providers. It holds no secret.
      </p>
      <a href="/api/export" download className="wic-btn wic-focus wic-btn-ink">
        Download my data
      </a>
      <Consents />
      <h4 className="panel-sub">Given to the commons</h4>
      <Suspense fallback={<Skeleton lines={2} label="Loading conversations" />}>
        <Contributed me={me} />
      </Suspense>
      <h4 className="panel-sub">Delete the account</h4>
      <Suspense fallback={<Skeleton lines={2} label="Loading conversations" />}>
        <DeleteAccount me={me} />
      </Suspense>
    </section>
  )
}

function Contributed({ me }: { me: Me }) {
  const { data } = useLiveSuspenseQuery({
    query: (q) =>
      q
        .from({ c: conversationsCollection })
        .where(({ c }) => and(eq(c.owner_id, me.id), not(isNull(c.contributed_at))))
        .orderBy(({ c }) => c.contributed_at, 'desc'),
  })
  if (data.length === 0) return <p>No conversation of yours is in the commons.</p>
  return (
    <ul className="facts-list">
      {data.map((c) => (
        <li key={c.id}>
          <span>{c.title || 'Untitled'}</span>
          <span className="manage-meta">since {day(c.contributed_at ?? c.created_at)}</span>
        </li>
      ))}
    </ul>
  )
}

type ConsentRow = ConsentKind & { answer: { granted: boolean; at: string } | null }

/** The kinds of consent that concern accounts; absent while there is none. */
function Consents() {
  const [rows, setRows] = useState<ConsentRow[] | null>(null)
  useEffect(() => {
    void fetch('/api/consents')
      .then((r) => r.json() as Promise<ConsentRow[]>)
      .then(setRows)
      .catch(() => setRows([]))
  }, [])
  if (!rows || rows.length === 0) return null
  return (
    <>
      <h4 className="panel-sub">Consent</h4>
      {rows.map((row) => (
        <Switch
          key={row.id}
          label={row.title}
          hint={row.text}
          checked={row.answer?.granted ?? false}
          onChange={(e) => {
            const granted = e.target.checked
            void fetch(`/api/consents/${row.id}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ granted }),
            }).then((r) => {
              if (r.ok) {
                setRows(
                  rows.map((x) =>
                    x.id === row.id
                      ? { ...x, answer: { granted, at: new Date().toISOString() } }
                      : x,
                  ),
                )
              }
            })
          }}
        />
      ))}
    </>
  )
}

function DeleteAccount({ me }: { me: Me }) {
  const { data } = useLiveSuspenseQuery({
    query: (q) => q.from({ c: conversationsCollection }).where(({ c }) => eq(c.owner_id, me.id)),
  })
  const [now, setNow] = useState(() => Date.now())
  const [failed, setFailed] = useState<string | null>(null)
  // The window of a fresh sign-in closes while the section is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const fresh = me.signedInAt !== null && now - me.signedInAt < FRESH_SIGN_IN_MS
  const given = data.filter((c) => c.contributed_at).length
  const erased = data.length - given
  const back = '/?settings=data'

  async function remove() {
    setFailed(null)
    const response = await fetch('/api/me', { method: 'DELETE' }).catch(() => null)
    if (response?.ok) {
      localStorage.setItem('wica-clear-account', me.id)
      location.assign('/login')
      return
    }
    setFailed(
      response?.status === 403
        ? 'Your sign-in is more than 5 minutes old: sign in again to delete the account.'
        : 'The account could not be deleted. Nothing was removed if this persists; try again.',
    )
  }

  if (!fresh) {
    return (
      <>
        <p>
          To delete the account, sign in again first: the deletion is open for 5 minutes after a
          sign-in.
        </p>
        <Button variant="quiet" onClick={() => void signInAgain(me, back)}>
          Sign in again
        </Button>
      </>
    )
  }
  return (
    <>
      <p>
        Deleting the account erases {erased === 1 ? '1 conversation' : `${erased} conversations`}{' '}
        with every message, and your keys, model provider sign-ins, tool servers and skills.{' '}
        {given > 0
          ? `${given === 1 ? '1 conversation given' : `${given} conversations given`} to the commons ${given === 1 ? 'stays' : 'stay'} there, without your account, since the dedication cannot be withdrawn. `
          : ''}
        This cannot be undone.
      </p>
      <Button variant="primary" onClick={() => void remove()}>
        Delete my account
      </Button>
      <p className="failure" role="alert">
        {failed}
      </p>
    </>
  )
}
