// The kinds of consent the hub asks for. Each kind has its own text and its own answer; the code
// that depends on a kind runs only once it is granted. A kind is asked only of the people it
// concerns: guests keep their answers in the browser, accounts on the server.

export type ConsentAudience = 'guest' | 'account'

export type ConsentKind = {
  id: string
  title: string
  text: string
  audience: ConsentAudience[]
}

export const CONSENT_KINDS = [
  {
    id: 'protection',
    title: 'Abuse protection',
    text:
      'To let you try the hub without an account, this page computes a fingerprint of your ' +
      'browser (its screen, fonts and graphics) and your network address, to count your messages ' +
      'each day. Only a code that cannot be turned back into these details is kept, and it is ' +
      'used for nothing else.',
    audience: ['guest'],
  },
] as const satisfies readonly ConsentKind[]

export type ConsentId = (typeof CONSENT_KINDS)[number]['id']

/** The kinds that concern this audience. */
export const consentKindsFor = (audience: ConsentAudience): readonly ConsentKind[] =>
  CONSENT_KINDS.filter((kind) => (kind.audience as readonly ConsentAudience[]).includes(audience))
