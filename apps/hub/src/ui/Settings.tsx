// Account settings, shown in the settings dialog: a sidebar of sections, one shown at a time. The
// section is in the address (`?settings=providers`), so a link or a return from a sign-in page opens
// it again.

import {
  Button,
  Notice,
  SecretField,
  SectionHeading,
  Select,
  Skeleton,
  Switch,
  TextInput,
} from '@workers-intelligence-commons/components'
import { Link } from '@tanstack/react-router'
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { logout } from '../client/session.ts'
import type { Me } from '../shared/session.ts'
import { ApiKeys } from './ApiKeys.tsx'
import { Skills } from './Skills.tsx'
import { ToolServers } from './ToolServers.tsx'

export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'providers', label: 'Model providers' },
  { id: 'wic', label: 'WIC provider' },
  { id: 'tools', label: 'Tool servers' },
  { id: 'skills', label: 'Skills' },
  { id: 'keys', label: 'API keys' },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

/** The section named in the address; `undefined` when it names none. */
export const settingsSection = (value: unknown): SettingsSection | undefined =>
  SETTINGS_SECTIONS.find((s) => s.id === value)?.id

/** `toolServer`: the outcome of a tool server sign-in, on the return from its sign-in page. */
export function Settings(props: {
  me: Me
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  toolServer: string | undefined
}) {
  const pages: Record<SettingsSection, () => ReactNode> = {
    account: () => <Account me={props.me} />,
    providers: () => <Providers />,
    wic: () => <WicProvider />,
    tools: () => <ToolServers returned={props.toolServer} />,
    skills: () => <Skills admin={props.me.admin} />,
    keys: () => <ApiKeys />,
  }
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Sections of the settings">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="settings-tab wic-focus"
            aria-current={s.id === props.section ? 'page' : undefined}
            onClick={() => props.onSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-page wic-enter" key={props.section}>
        {pages[props.section]()}
      </div>
    </div>
  )
}

function Account({ me }: { me: Me }) {
  return (
    <section className="panel">
      <SectionHeading level={3} kicker="who you are here">
        Account
      </SectionHeading>
      <dl className="facts">
        <dt>Name</dt>
        <dd>{me.name}</dd>
        <dt>Role</dt>
        <dd>{me.admin ? 'Administrator of this instance' : 'Member of this instance'}</dd>
      </dl>
      <div className="inline">
        {me.admin ? (
          <Link to="/admin" className="wic-btn wic-focus wic-btn-quiet">
            Administration
          </Link>
        ) : null}
        <Button variant="quiet" onClick={() => void logout(me.id)}>
          Sign out
        </Button>
      </div>
    </section>
  )
}

const CONTRIBUTE_TEXT =
  'When this is on, the conversations you have from now on are dedicated to the public domain ' +
  "under CC0 1.0: anyone may use them, and Workers' Intelligence Commons will use them to train " +
  'its models. Before training, they are anonymized: names, addresses and other details that ' +
  'identify a person are removed. A dedication cannot be withdrawn: switching this off stops new ' +
  'contributions only.'

function WicProvider() {
  const [on, setOn] = useState<boolean | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    void fetch('/api/contributor')
      .then((r) => r.json() as Promise<{ on: boolean }>)
      .then((b) => setOn(b.on))
      .catch(() => setFailure('The setting could not be loaded.'))
  }, [])

  async function change(next: boolean) {
    setFailure(null)
    setOn(next)
    const response = await fetch('/api/contributor', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: next }),
    }).catch(() => null)
    if (!response?.ok) {
      setOn(!next)
      setFailure('The setting was not saved.')
    }
  }

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="the commons' own models">
        WIC provider
      </SectionHeading>
      {on === null && !failure ? <Skeleton lines={2} label="Loading the setting" /> : null}
      {on !== null ? (
        <Switch
          label="Contribute my conversations"
          hint={CONTRIBUTE_TEXT}
          checked={on}
          onChange={(e) => void change(e.target.checked)}
        />
      ) : null}
      {failure ? (
        <p className="failure" role="alert">
          {failure}
        </p>
      ) : null}
      <p className="aside-note">Allowances and subscriptions are not available yet.</p>
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

/** Where the person is in connecting a provider: the list, then three steps. */
type Step =
  | { at: 'list' }
  | { at: 'choose' }
  | { at: 'method'; provider: Provider }
  | { at: 'key'; provider: Provider }
  | { at: 'signin'; provider: Provider }

/** The step after choosing a provider: the method, unless it offers only one. */
const afterChoice = (provider: Provider): Step =>
  provider.apiKey && provider.oauth
    ? { at: 'method', provider }
    : provider.apiKey
      ? { at: 'key', provider }
      : { at: 'signin', provider }

function Providers() {
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [step, setStep] = useState<Step>({ at: 'list' })
  const reload = useCallback(() => {
    void fetch('/api/credentials')
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
      .then((b) => setProviders(b.providers))
  }, [])
  useEffect(reload, [reload])

  const usable = (providers ?? []).filter((p) => p.apiKey || p.oauth)
  const connected = usable.filter((p) => p.connected)
  const done = () => {
    reload()
    setStep({ at: 'list' })
  }

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="your model accounts">
        Model providers
      </SectionHeading>
      {warning ? (
        <div className="warning" role="alert">
          <Notice title="before you go on">{warning}</Notice>
          <Button onClick={() => setWarning(null)}>I understand</Button>
        </div>
      ) : null}
      {providers === null ? <Skeleton lines={3} label="Loading providers" /> : null}
      {providers !== null && step.at === 'list' ? (
        <>
          {connected.length === 0 ? (
            <p className="aside-note">
              No provider is connected yet. The models of a provider appear in the model menu once
              it is connected.
            </p>
          ) : (
            <ul className="rows">
              {connected.map((p) => (
                <li key={p.id}>
                  <span className="row-name">{p.name}</span>
                  <span className="row-detail">
                    {p.connected === 'oauth' ? 'a subscription' : 'an API key'}
                  </span>
                  <Button
                    variant="quiet"
                    onClick={() =>
                      void fetch(`/api/credentials/${encodeURIComponent(p.id)}`, {
                        method: 'DELETE',
                      }).then(reload)
                    }
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="primary" onClick={() => setStep({ at: 'choose' })}>
            Add provider
          </Button>
        </>
      ) : null}
      {step.at === 'choose' ? (
        <ChooseProvider
          providers={usable.filter((p) => !p.connected)}
          onChoose={(p) => setStep(afterChoice(p))}
          onBack={() => setStep({ at: 'list' })}
        />
      ) : null}
      {step.at === 'method' ? (
        <Wizard
          n={2}
          title={`How to connect ${step.provider.name}`}
          onBack={() => setStep({ at: 'choose' })}
        >
          <div className="inline">
            <Button onClick={() => setStep({ at: 'key', provider: step.provider })}>
              Use an API key
            </Button>
            <Button onClick={() => setStep({ at: 'signin', provider: step.provider })}>
              {step.provider.oauth?.subscription ? 'Connect a subscription' : 'Sign in'}
            </Button>
          </div>
        </Wizard>
      ) : null}
      {step.at === 'key' ? (
        <Wizard
          n={3}
          title={`The API key of ${step.provider.name}`}
          onBack={() => setStep(backFrom(step.provider))}
        >
          <KeyForm provider={step.provider} onSaved={done} />
        </Wizard>
      ) : null}
      {step.at === 'signin' ? (
        <Wizard
          n={3}
          title={`Sign in to ${step.provider.name}`}
          onBack={() => setStep(backFrom(step.provider))}
        >
          <SignIn
            provider={step.provider}
            onDone={(w) => {
              if (w) setWarning(w)
              done()
            }}
          />
        </Wizard>
      ) : null}
    </section>
  )
}

/** Back from the last step: to the method when there was a choice, else to the providers. */
const backFrom = (provider: Provider): Step =>
  provider.apiKey && provider.oauth ? { at: 'method', provider } : { at: 'choose' }

function Wizard(props: { n: number; title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="wizard wic-enter">
      <p className="wizard-step">step {props.n} of 3</p>
      <h4 className="wizard-title">{props.title}</h4>
      {props.children}
      <div className="wizard-foot">
        <Button variant="quiet" onClick={props.onBack}>
          Back
        </Button>
      </div>
    </div>
  )
}

function ChooseProvider(props: {
  providers: Provider[]
  onChoose: (p: Provider) => void
  onBack: () => void
}) {
  const [filter, setFilter] = useState('')
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = props.providers.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
  return (
    <Wizard n={1} title="Which provider" onBack={props.onBack}>
      <TextInput
        label="Filter the providers"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        autoFocus
      />
      <ul className="choices">
        {shown.map((p) => (
          <li key={p.id}>
            <button type="button" className="choice wic-focus" onClick={() => props.onChoose(p)}>
              <span className="row-name">{p.name}</span>
              <span className="row-detail">
                {[
                  p.apiKey ? 'API key' : null,
                  p.oauth ? (p.oauth.subscription ? 'subscription' : 'sign-in') : null,
                ]
                  .filter(Boolean)
                  .join(' or ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length === 0 ? <p className="aside-note">No provider matches.</p> : null}
    </Wizard>
  )
}

function KeyForm(props: { provider: Provider; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  async function save(event: FormEvent) {
    event.preventDefault()
    setFailure(null)
    const response = await fetch('/api/credentials/api-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: props.provider.id, key }),
    }).catch(() => null)
    if (!response?.ok) return setFailure('The key was not saved.')
    props.onSaved()
  }
  return (
    <form onSubmit={save} className="inline">
      <SecretField
        label={`${props.provider.name} API key`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        required
        autoFocus
      />
      <Button type="submit" variant="primary">
        Save the key
      </Button>
      {failure ? (
        <p className="failure" role="alert">
          {failure}
        </p>
      ) : null}
    </form>
  )
}

/**
 * Some providers send the browser back only to an address on the person's own computer, which
 * never reaches the hub: the person pastes that address instead.
 */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/

/** The sign-in of a provider, started at once; leaving the step ends it. */
function SignIn(props: { provider: Provider; onDone: (warning: string | null) => void }) {
  const { provider } = props
  const [login, setLogin] = useState<LoginEvent[]>([])
  const [answer, setAnswer] = useState('')
  const onDone = useRef(props.onDone)
  onDone.current = props.onDone

  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      const response = await fetch(`/api/credentials/login/${encodeURIComponent(provider.id)}`, {
        method: 'POST',
        signal: abort.signal,
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
          if (event.type === 'done') onDone.current(event.warning)
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) {
        setLogin((l) => [...l, { type: 'error', message: `The sign-in stopped: ${String(error)}` }])
      }
    })
    return () => abort.abort()
  }, [provider.id])

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
    <div className="signin">
      {login.length === 0 ? <Skeleton lines={1} label="Starting the sign-in" /> : null}
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
          ) : prompt.prompt.type === 'secret' ? (
            <SecretField
              label={prompt.prompt.message}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={prompt.prompt.placeholder}
              required
            />
          ) : (
            <TextInput
              label={prompt.prompt.message}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={prompt.prompt.placeholder}
              hint={
                LOOPBACK.test(prompt.prompt.placeholder ?? '')
                  ? "After you sign in, your browser ends on a page that does not load. Copy that page's address from the address bar and paste it here."
                  : undefined
              }
              required
            />
          )}
          <Button type="submit">Send</Button>
        </form>
      ) : null}
    </div>
  )
}
