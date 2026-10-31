// Login: by API key in bootstrap mode, by the OIDC issuer otherwise. Behind a trusted proxy, the
// page is never reached: the proxy has already authenticated the person.

import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  Button,
  ButtonLink,
  Mark,
  SectionHeading,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

import { getAuthMode, getMe } from '../client/session.ts'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    if (await getMe()) throw redirect({ to: '/' })
  },
  loader: () => getAuthMode(),
  component: Login,
})

function Login() {
  const mode = Route.useLoaderData()
  const [key, setKey] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(null)
    const response = await fetch('/auth/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key.trim() }),
    })
    setBusy(false)
    if (response.ok) location.assign('/')
    else setFailed('This key opens no account.')
  }

  return (
    <main className="login">
      <Mark name="wic" height={64} label="Workers' Intelligence Commons" />
      <SectionHeading kicker="wica">Sign in</SectionHeading>
      {mode === 'oidc' ? (
        <ButtonLink href="/auth/oidc" variant="primary">
          Sign in with your identity provider
        </ButtonLink>
      ) : (
        <form onSubmit={submit}>
          <TextInput
            id="key"
            type="password"
            label="Your account's API key"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="wica_…"
            required
            error={failed}
          />
          <Button type="submit" variant="primary" disabled={busy}>
            Sign in
          </Button>
        </form>
      )}
    </main>
  )
}
