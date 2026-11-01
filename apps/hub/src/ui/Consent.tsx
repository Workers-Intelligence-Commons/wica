// What a person without an account sees before talking to the instance's model: the kinds of
// consent that concern guests, each with its text and its own answer. Guest chat starts only once
// the protection consent is granted; declining leaves the sign-in and the sign-up.

import { Link } from '@tanstack/react-router'
import { Button, Notice, Poster, SectionHeading } from '@workers-intelligence-commons/components'
import { useState } from 'react'

import { answerConsent, guestConsents, startGuest } from '../client/guest.ts'
import { type ConsentId, consentKindsFor } from '../shared/consent.ts'

export function GuestGate() {
  const kinds = consentKindsFor('guest')
  const [answers, setAnswers] = useState(guestConsents)
  const [failed, setFailed] = useState<string | null>(null)
  const declined = answers['protection']?.granted === false

  async function answer(kind: ConsentId, granted: boolean) {
    answerConsent(kind, granted)
    setAnswers(guestConsents())
    if (kind !== 'protection' || !granted) return
    try {
      await startGuest()
      // The cache of the guest opens before the page, as for an account.
      location.reload()
    } catch {
      setFailed('The hub could not start a guest session. Try again later, or sign in.')
    }
  }

  return (
    <section className="conversation start">
      <Poster className="chat-sheet guest-gate">
        <SectionHeading kicker="without an account">Try the hub</SectionHeading>
        <p>
          You can talk to this instance's model without an account. Your conversations stay in this
          browser until you sign in, and then they move to your account.
        </p>
        {kinds.map((kind) => (
          <section key={kind.id} className="consent" aria-labelledby={`consent-${kind.id}`}>
            <h3 id={`consent-${kind.id}`}>{kind.title}</h3>
            <p>{kind.text}</p>
            <div className="consent-actions">
              <Button variant="primary" onClick={() => void answer(kind.id as ConsentId, true)}>
                Agree
              </Button>
              <Button variant="quiet" onClick={() => void answer(kind.id as ConsentId, false)}>
                Decline
              </Button>
            </div>
          </section>
        ))}
        {declined ? (
          <Notice title="guest chat off">
            Without this consent the hub cannot count your messages, so guest chat stays closed. You
            can still create an account.
          </Notice>
        ) : null}
        <p className="failure" role="alert">
          {failed}
        </p>
        <p className="guest-links">
          <Link to="/login" className="wic-btn wic-focus wic-btn-quiet">
            Sign in
          </Link>
          <Link to="/signup" className="wic-btn wic-focus wic-btn-quiet">
            Create an account
          </Link>
        </p>
      </Poster>
    </section>
  )
}
