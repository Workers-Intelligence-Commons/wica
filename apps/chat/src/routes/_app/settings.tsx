// Réglages du compte : serveurs distants (création, jeton montré une fois, révocation) et
// jetons de modèle (clé d'API, ou connexion à un abonnement avec son avertissement unique).

import { eq, useLiveQuery } from '@tanstack/react-db'
import { createFileRoute } from '@tanstack/react-router'
import {
  Button,
  Notice,
  SectionHeading,
  Select,
  Skeleton,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

import { serversCollection } from '../../client/collections.ts'

export const Route = createFileRoute('/_app/settings')({ component: Settings })

function Settings() {
  return (
    <section className="settings">
      <SectionHeading kicker="your account">Settings</SectionHeading>
      <Servers />
      <Credentials />
    </section>
  )
}

function Servers() {
  const { me } = Route.useRouteContext()
  const { data: servers } = useLiveQuery({
    query: (q) => q.from({ s: serversCollection }).where(({ s }) => eq(s.owner_id, me.id)),
  })
  const [name, setName] = useState('')
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null)

  async function create(event: FormEvent) {
    event.preventDefault()
    const response = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (response.ok) {
      setCreated((await response.json()) as { id: string; token: string })
      setName('')
    }
  }

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="your machines">
        Remote servers
      </SectionHeading>
      <p>
        A remote server runs on your machine or in a sandbox, with access to its files and its
        terminal. The chat server itself has no access to any system.
      </p>
      <ul className="rows">
        {servers
          .filter((s) => !s.revoked_at)
          .map((s) => (
            <li key={s.id}>
              <span className="row-name">{s.name}</span>
              <span className="row-detail">
                {s.last_seen_at
                  ? `seen ${new Date(s.last_seen_at).toLocaleString('en-GB')}`
                  : 'never connected'}
              </span>
              <Button
                variant="quiet"
                onClick={() => void fetch(`/api/servers/${s.id}`, { method: 'DELETE' })}
              >
                Revoke
              </Button>
            </li>
          ))}
      </ul>
      {created ? (
        <div className="secret">
          <p>The server token, shown only once:</p>
          <pre>{created.token}</pre>
          <p>On the server's machine:</p>
          <pre>{`WICA_CHAT_TOKEN=${created.token} wica remote ${location.origin}`}</pre>
        </div>
      ) : null}
      <form onSubmit={create} className="inline">
        <TextInput
          label="Server name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Button type="submit">Add the server</Button>
      </form>
    </section>
  )
}

type Provider = {
  id: string
  name: string
  apiKey: boolean
  oauth: { name: string; subscription: boolean } | null
  connected: 'api_key' | 'oauth' | null
}

type LoginEvent =
  | {
      type: 'notify'
      event: {
        type: string
        message?: string
        url?: string
        instructions?: string
        userCode?: string
        verificationUri?: string
      }
    }
  | {
      type: 'prompt'
      loginId: string
      prompt: {
        type: string
        message: string
        placeholder?: string
        options?: { id: string; label: string }[]
      }
    }
  | { type: 'done'; warning: string | null }
  | { type: 'error'; message: string }

function Credentials() {
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const reload = useCallback(() => {
    void fetch('/api/credentials')
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
      .then((b) => setProviders(b.providers))
  }, [])
  useEffect(reload, [reload])

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="your model accounts">
        Hosted models
      </SectionHeading>
      {warning ? (
        <div className="warning" role="alert">
          <Notice title="before you go on">{warning}</Notice>
          <Button onClick={() => setWarning(null)}>I understand</Button>
        </div>
      ) : null}
      {providers === null ? <Skeleton lines={4} label="Loading providers" /> : null}
      <ul className="rows">
        {(providers ?? [])
          .filter((p) => p.apiKey || p.oauth)
          .map((p) => (
            <ProviderRow key={p.id} provider={p} onChange={reload} onWarning={setWarning} />
          ))}
      </ul>
    </section>
  )
}

function ProviderRow(props: {
  provider: Provider
  onChange: () => void
  onWarning: (w: string) => void
}) {
  const { provider } = props
  const [key, setKey] = useState('')
  const [login, setLogin] = useState<LoginEvent[]>([])
  const [answer, setAnswer] = useState('')

  async function saveKey(event: FormEvent) {
    event.preventDefault()
    await fetch('/api/credentials/api-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: provider.id, key }),
    })
    setKey('')
    props.onChange()
  }

  async function connect() {
    setLogin([])
    const response = await fetch(`/api/credentials/login/${encodeURIComponent(provider.id)}`, {
      method: 'POST',
    })
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const chunk = await reader?.read()
      if (!chunk || chunk.done) break
      buffer += chunk.value
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = JSON.parse(frame.replace(/^data: /, '')) as LoginEvent
        setLogin((l) => [...l, event])
        if (event.type === 'done') {
          if (event.warning) props.onWarning(event.warning)
          props.onChange()
        }
      }
    }
  }

  const prompt = [...login].reverse().find((e) => e.type === 'prompt')
  const finished = login.some((e) => e.type === 'done' || e.type === 'error')

  async function reply(event: FormEvent) {
    event.preventDefault()
    if (prompt?.type !== 'prompt') return
    await fetch(`/api/credentials/login/${prompt.loginId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    })
    setAnswer('')
  }

  return (
    <li className="provider">
      <div className="inline">
        <span className="row-name">{provider.name}</span>
        <span className="row-detail">
          {provider.connected
            ? `connected with ${provider.connected === 'oauth' ? 'a subscription' : 'an API key'}`
            : 'not connected'}
        </span>
        {provider.connected ? (
          <Button
            variant="quiet"
            onClick={() =>
              void fetch(`/api/credentials/${encodeURIComponent(provider.id)}`, {
                method: 'DELETE',
              }).then(props.onChange)
            }
          >
            Revoke
          </Button>
        ) : null}
        {provider.oauth ? (
          <Button onClick={() => void connect()}>
            {provider.oauth.subscription ? 'Connect a subscription' : 'Sign in'}
          </Button>
        ) : null}
      </div>
      {provider.apiKey ? (
        <form onSubmit={saveKey} className="inline">
          <TextInput
            label={`${provider.name} API key`}
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
          />
          <Button type="submit">Save the key</Button>
        </form>
      ) : null}
      {login.map((e, i) =>
        e.type === 'notify' ? (
          <p key={i}>
            {e.event.message ?? e.event.instructions}{' '}
            {e.event.url ? (
              <a href={e.event.url} target="_blank" rel="noreferrer">
                Open the sign-in page
              </a>
            ) : null}
            {e.event.userCode ? (
              <>
                Code <code>{e.event.userCode}</code> at{' '}
                <a href={e.event.verificationUri} target="_blank" rel="noreferrer">
                  {e.event.verificationUri}
                </a>
              </>
            ) : null}
          </p>
        ) : e.type === 'error' ? (
          <p key={i} className="failure" role="alert">
            {e.message}
          </p>
        ) : null,
      )}
      {prompt?.type === 'prompt' && !finished ? (
        <form onSubmit={reply} className="inline">
          {prompt.prompt.type === 'select' ? (
            <Select
              label={prompt.prompt.message}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              required
            >
              <option value="" />
              {(prompt.prompt.options ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <TextInput
              label={prompt.prompt.message}
              type={prompt.prompt.type === 'secret' ? 'password' : 'text'}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={prompt.prompt.placeholder}
              required
            />
          )}
          <Button type="submit">Send</Button>
        </form>
      ) : null}
    </li>
  )
}
