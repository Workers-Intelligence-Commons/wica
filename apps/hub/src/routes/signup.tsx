// Creation of an account of the hub, on its own page so that password managers save it as a new
// login. Only the `accounts` sign-in mode keeps accounts: in the other modes the page leads to
// the sign-in. When the hub sends emails, the account confirms its address before its first
// sign-in.

import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  AccountField,
  Button,
  ButtonLink,
  Mark,
  NewPasswordField,
  SectionHeading,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

import { getMe, getSignIn } from '../client/session.ts'
import { PASSWORD_LENGTH } from '../shared/accounts.ts'

export const Route = createFileRoute('/signup')({
  beforeLoad: async () => {
    if (await getMe()) throw redirect({ to: '/' })
  },
  loader: async () => {
    const signIn = await getSignIn()
    if (signIn.kind !== 'accounts') throw redirect({ to: '/login' })
    return signIn
  },
  component: SignUp,
})

function SignUp() {
  const { email: sendsEmail } = Route.useLoaderData()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setFailed(null)
    const response = await fetch('/auth/account/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        password,
        callbackURL: '/login',
      }),
    })
    setBusy(false)
    if (response.ok && sendsEmail) {
      setConfirming(true)
      return
    }
    if (response.ok) {
      location.assign('/')
      return
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    setFailed(body.message ?? 'The account was not created.')
  }

  return (
    <main className="login">
      <Mark name="wic" height={64} label="Workers' Intelligence Commons" />
      {confirming ? (
        <>
          <SectionHeading kicker="wica">Confirm your address</SectionHeading>
          <p>A confirmation link is on its way to {email.trim()}. Open it, then sign in.</p>
        </>
      ) : (
        <>
          <SectionHeading kicker="wica">Create an account</SectionHeading>
          <form onSubmit={submit}>
            <TextInput
              id="name"
              label="Display name"
              hint="The name others see in the hub."
              autoComplete="nickname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <AccountField
              id="email"
              label="Email address"
              creating
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <NewPasswordField
              id="password"
              label="Password"
              hint={`${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters.`}
              minLength={PASSWORD_LENGTH.min}
              maxLength={PASSWORD_LENGTH.max}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              error={failed}
            />
            <Button type="submit" variant="primary" disabled={busy}>
              Create the account
            </Button>
          </form>
        </>
      )}
      <ButtonLink href="/login">I already have an account</ButtonLink>
    </main>
  )
}
