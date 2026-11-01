// The tool servers (MCP) of the account, in the settings: the connected ones, the catalog of the
// instance, and the servers the person adds at a public address. An OAuth sign-in leaves for the
// server's sign-in page, and comes back to the settings with `toolServer` in the address.

import {
  Button,
  Notice,
  SecretField,
  SectionHeading,
  Select,
  Skeleton,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

type CatalogEntry = { id: string; name: string; url: string; description: string }
type Connection = {
  id: string
  name: string
  url: string
  catalogId: string | null
  auth: 'none' | 'token' | 'oauth'
  status: 'connected' | 'sign_in'
}
type Listing = { catalog: CatalogEntry[]; connections: Connection[] }

const RETURN_MESSAGES: Record<string, string> = {
  connected: 'The tool server is connected.',
  refused: 'The tool server sign-in was refused.',
  failed: 'The tool server sign-in failed. Try again.',
}

const AUTH_LABELS = { none: 'no sign-in', token: 'a fixed token', oauth: 'OAuth sign-in' }

async function answer(response: Response, onDone: () => void) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    redirect?: string | null
  }
  if (!response.ok) return body.error ?? 'The tool server was not connected.'
  if (body.redirect) location.assign(body.redirect)
  else onDone()
  return null
}

export function ToolServers({ returned }: { returned: string | undefined }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const reload = useCallback(() => {
    void fetch('/api/mcp')
      .then((r) => r.json() as Promise<Listing>)
      .then(setListing)
  }, [])
  useEffect(reload, [reload])

  const connected = new Set(listing?.connections.map((c) => c.catalogId))
  const message = returned ? RETURN_MESSAGES[returned] : undefined

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="tools for your conversations">
        Tool servers
      </SectionHeading>
      {message ? <Notice title="tool server">{message}</Notice> : null}
      {listing === null ? <Skeleton lines={3} label="Loading tool servers" /> : null}
      <ul className="rows">
        {(listing?.connections ?? []).map((c) => (
          <ConnectionRow key={c.id} connection={c} onChange={reload} />
        ))}
      </ul>
      {(listing?.catalog ?? [])
        .filter((entry) => !connected.has(entry.id))
        .map((entry) => (
          <div key={entry.id} className="provider">
            <div className="inline">
              <span className="row-name">{entry.name}</span>
              <span className="row-detail">{entry.description || entry.url}</span>
            </div>
            <ConnectForm catalogId={entry.id} label={entry.name} onDone={reload} />
          </div>
        ))}
      {listing ? (
        <div className="provider">
          <span className="row-name">Your own server</span>
          <ConnectForm catalogId={null} label="your server" onDone={reload} />
        </div>
      ) : null}
    </section>
  )
}

function ConnectionRow({ connection, onChange }: { connection: Connection; onChange: () => void }) {
  const [failed, setFailed] = useState<string | null>(null)

  async function signIn() {
    const response = await fetch(`/api/mcp/${connection.id}/sign-in`, { method: 'POST' })
    setFailed(await answer(response, onChange))
  }

  return (
    <li className="provider">
      <div className="inline">
        <span className="row-name">{connection.name}</span>
        <span className="row-detail">
          {connection.status === 'connected' ? 'connected' : 'sign-in needed'} ·{' '}
          {AUTH_LABELS[connection.auth]} · {connection.url}
        </span>
        {connection.auth === 'oauth' ? (
          <Button onClick={() => void signIn()}>
            {connection.status === 'connected' ? 'Sign in again' : 'Sign in'}
          </Button>
        ) : null}
        <Button
          variant="quiet"
          onClick={() =>
            void fetch(`/api/mcp/${connection.id}`, { method: 'DELETE' }).then(onChange)
          }
        >
          Remove
        </Button>
      </div>
      {failed ? (
        <p className="failure" role="alert">
          {failed}
        </p>
      ) : null}
    </li>
  )
}

/** Connects a catalog server (`catalogId`), or the person's own server when it is `null`. */
function ConnectForm(props: { catalogId: string | null; label: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<Connection['auth']>('none')
  const [token, setToken] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    const response = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(props.catalogId ? { catalogId: props.catalogId } : { name, url }),
        auth,
        ...(auth === 'token' ? { token } : {}),
      }),
    })
    setBusy(false)
    setFailed(await answer(response, props.onDone))
  }

  return (
    <form onSubmit={submit} className="inline">
      {props.catalogId ? null : (
        <>
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
        </>
      )}
      <Select
        label={`Sign-in to ${props.label}`}
        value={auth}
        onChange={(e) => setAuth(e.target.value as Connection['auth'])}
      >
        <option value="none">{AUTH_LABELS.none}</option>
        <option value="token">{AUTH_LABELS.token}</option>
        <option value="oauth">{AUTH_LABELS.oauth}</option>
      </Select>
      {auth === 'token' ? (
        <SecretField
          label="Token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
      ) : null}
      <Button type="submit" disabled={busy}>
        Connect
      </Button>
      {failed ? (
        <p className="failure" role="alert">
          {failed}
        </p>
      ) : null}
    </form>
  )
}
