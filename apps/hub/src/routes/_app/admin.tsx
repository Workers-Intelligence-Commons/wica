// Administration of the instance, for the accounts with the admin role: the accounts and their
// role, the reset of a password when the hub keeps the accounts, and the tool server catalog.

import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  Button,
  SecretField,
  SectionHeading,
  Skeleton,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

import { PASSWORD_LENGTH } from '../../shared/accounts.ts'
import { TopBar } from '../../ui/TopBar.tsx'

export const Route = createFileRoute('/_app/admin')({
  beforeLoad: ({ context }) => {
    if (!context.me.admin) throw redirect({ to: '/' })
  },
  component: Admin,
})

type Account = { id: string; name: string; admin: boolean }

function Admin() {
  return (
    <section className="page">
      <TopBar />
      <div className="page-body">
        <SectionHeading kicker="the instance">Administration</SectionHeading>
        <Accounts />
        <Catalog />
      </div>
    </section>
  )
}

function Accounts() {
  const { me } = Route.useRouteContext()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const reload = useCallback(() => {
    void fetch('/api/admin/accounts')
      .then((r) => r.json() as Promise<Account[]>)
      .then(setAccounts)
  }, [])
  useEffect(reload, [reload])

  async function setAdmin(account: Account, admin: boolean) {
    await fetch(`/api/admin/accounts/${account.id}/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ admin }),
    })
    reload()
  }

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="people">
        Accounts
      </SectionHeading>
      {accounts === null ? <Skeleton lines={4} label="Loading accounts" /> : null}
      <ul className="rows">
        {(accounts ?? []).map((account) => (
          <li key={account.id} className="provider">
            <div className="inline">
              <span className="row-name">{account.name}</span>
              <span className="row-detail">{account.admin ? 'admin' : 'member'}</span>
              <Button variant="quiet" onClick={() => void setAdmin(account, !account.admin)}>
                {account.admin ? 'Remove the admin role' : 'Make admin'}
              </Button>
            </div>
            {me.auth === 'accounts' ? <PasswordReset account={account} /> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Without an email sender, a forgotten password comes back only through an admin. */
function PasswordReset({ account }: { account: Account }) {
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const response = await fetch(`/api/admin/accounts/${account.id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    setDone(response.ok)
    setFailed(response.ok ? null : (body.error ?? 'The password was not replaced.'))
    if (response.ok) setPassword('')
  }

  return (
    <form onSubmit={submit} className="inline">
      <SecretField
        label={`New password for ${account.name}`}
        minLength={PASSWORD_LENGTH.min}
        maxLength={PASSWORD_LENGTH.max}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        error={failed}
      />
      <Button type="submit">Reset the password</Button>
      {done ? (
        <span className="row-detail">Password replaced; the account signs in again.</span>
      ) : null}
    </form>
  )
}

type CatalogEntry = { id: string; name: string; url: string; description: string }

/** Tool servers offered to every account; their address may be on the instance's network. */
function Catalog() {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const reload = useCallback(() => {
    void fetch('/api/admin/mcp')
      .then((r) => r.json() as Promise<CatalogEntry[]>)
      .then(setEntries)
  }, [])
  useEffect(reload, [reload])

  async function add(event: FormEvent) {
    event.preventDefault()
    const response = await fetch('/api/admin/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, url, description }),
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    setFailed(response.ok ? null : (body.error ?? 'The server was not added.'))
    if (!response.ok) return
    setName('')
    setUrl('')
    setDescription('')
    reload()
  }

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="for every account">
        Tool server catalog
      </SectionHeading>
      {entries === null ? <Skeleton lines={3} label="Loading the catalog" /> : null}
      <ul className="rows">
        {(entries ?? []).map((entry) => (
          <li key={entry.id} className="provider">
            <div className="inline">
              <span className="row-name">{entry.name}</span>
              <span className="row-detail">
                {entry.url}
                {entry.description ? ` · ${entry.description}` : ''}
              </span>
              <Button
                variant="quiet"
                onClick={() =>
                  void fetch(`/api/admin/mcp/${entry.id}`, { method: 'DELETE' }).then(reload)
                }
              >
                Remove, with every connection to it
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="inline">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="lowercase letters, digits, dashes"
          required
        />
        <TextInput
          label="Address"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
          required
        />
        <TextInput
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={failed}
        />
        <Button type="submit">Add to the catalog</Button>
      </form>
    </section>
  )
}
