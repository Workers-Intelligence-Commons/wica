// New password, from the link of a reset email: Better Auth checks the link, then sends the
// browser here with its token, or with `error` when the link is invalid or expired. The address
// of the account comes with the link, shown read-only so that password managers update that login.

import { createFileRoute } from '@tanstack/react-router'
import {
  AccountField,
  Button,
  ButtonLink,
  Mark,
  NewPasswordField,
  SectionHeading,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

import { PASSWORD_LENGTH } from '../shared/accounts.ts'

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search): { token?: string; error?: string; email?: string } => ({
    ...(typeof search.token === 'string' ? { token: search.token } : {}),
    ...(typeof search.error === 'string' ? { error: search.error } : {}),
    ...(typeof search.email === 'string' ? { email: search.email } : {}),
  }),
  component: ResetPassword,
})

function ResetPassword() {
  const { token, error, email } = Route.useSearch()
  const [password, setPassword] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const response = await fetch('/auth/account/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: password, token }),
    })
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    setDone(response.ok)
    setFailed(response.ok ? null : (body.message ?? 'The password was not replaced.'))
  }

  return (
    <main className="login">
      <Mark name="wic" height={64} label="Workers' Intelligence Commons" />
      <SectionHeading kicker="wica">Choose a new password</SectionHeading>
      {done ? (
        <p>Your password is replaced. Sign in with it.</p>
      ) : error || !token ? (
        <p>This reset link is invalid or has expired. Ask for a new one from the sign-in page.</p>
      ) : (
        <form onSubmit={submit}>
          {email ? <AccountField id="email" label="Account" value={email} readOnly /> : null}
          <NewPasswordField
            id="password"
            label="New password"
            hint={`${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters.`}
            minLength={PASSWORD_LENGTH.min}
            maxLength={PASSWORD_LENGTH.max}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            error={failed}
          />
          <Button type="submit" variant="primary">
            Replace the password
          </Button>
        </form>
      )}
      <ButtonLink href="/login">Back to the sign-in</ButtonLink>
    </main>
  )
}
