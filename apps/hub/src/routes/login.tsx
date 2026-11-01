// Sign-in: with an account of the hub (email and password, kept by Better Auth), or by the OIDC
// issuer. Behind a trusted proxy, the page is never reached: the proxy has already authenticated
// the person. A new account is created on its own page (`/signup`), so that password managers
// tell the two apart. When the hub sends emails, a person who forgot their password asks for a
// reset link here.

import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  AccountField,
  Button,
  ButtonLink,
  CurrentPasswordField,
  Mark,
  SectionHeading,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

import { getMe, getSignIn } from '../client/session.ts'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    if (await getMe()) throw redirect({ to: '/' })
  },
  loader: () => getSignIn(),
  component: Login,
})

function Login() {
  const signIn = Route.useLoaderData()
  return (
    <main className="login">
      <Mark name="hub" height={64} label="WIC hub" />
      {signIn.kind === 'oidc' ? (
        <>
          <SectionHeading kicker="wica">Sign in</SectionHeading>
          <ButtonLink href="/auth/oidc" variant="primary">
            Sign in with your identity provider
          </ButtonLink>
        </>
      ) : (
        <AccountSignIn email={signIn.email} />
      )}
    </main>
  )
}

/** Sign-in through the Better Auth routes of the hub. */
function AccountSignIn({ email: sendsEmail }: { email: boolean }) {
  const [forgotten, setForgotten] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(null)
    const response = await fetch('/auth/account/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    })
    setBusy(false)
    if (response.ok) {
      location.assign('/')
      return
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    setFailed(body.message ?? 'Sign-in refused.')
  }

  if (forgotten) return <ResetRequest onBack={() => setForgotten(false)} />

  return (
    <>
      <SectionHeading kicker="wica">Sign in</SectionHeading>
      <form onSubmit={submit}>
        <AccountField
          id="email"
          label="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <CurrentPasswordField
          id="password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          error={failed}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          Sign in
        </Button>
      </form>
      <ButtonLink href="/signup">Create an account</ButtonLink>
      {sendsEmail ? (
        <Button variant="quiet" onClick={() => setForgotten(true)}>
          I forgot my password
        </Button>
      ) : null}
    </>
  )
}

/**
 * Asks for a reset link by email; the answer is the same whether the address has an account. The
 * link's page receives the address, to show which account the new password is for.
 */
function ResetRequest({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const address = email.trim()
    const response = await fetch('/auth/account/request-password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: address,
        redirectTo: `/reset-password?email=${encodeURIComponent(address)}`,
      }),
    })
    setSent(response.ok)
    setFailed(response.ok ? null : 'The reset link was not sent. Try again later.')
  }

  return (
    <>
      <SectionHeading kicker="wica">Reset your password</SectionHeading>
      {sent ? (
        <p>If an account has this address, a reset link is on its way.</p>
      ) : (
        <form onSubmit={submit}>
          <AccountField
            id="email"
            label="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            error={failed}
          />
          <Button type="submit" variant="primary">
            Send the reset link
          </Button>
        </form>
      )}
      <Button variant="quiet" onClick={onBack}>
        Back to the sign-in
      </Button>
    </>
  )
}
