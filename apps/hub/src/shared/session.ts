// The session as the server reports it to the pages: `/api/me` and `/auth/mode`.

/** Sign-in mode of the hub. */
export type AuthKind = 'accounts' | 'oidc'

/** Account of the request. */
export type Me = {
  id: string
  name: string
  auth: AuthKind
  /** The account has the admin role. */
  admin: boolean
  /** When this browser session signed in, in milliseconds; `null` when unknown. */
  signedInAt: number | null
}

/** How recent a sign-in must be to delete the account. */
export const FRESH_SIGN_IN_MS = 5 * 60_000

/**
 * How the login page signs in: the mode, and whether the hub emails its accounts (confirmation
 * of the address, reset of a password).
 */
export type SignIn = {
  kind: AuthKind
  email: boolean
  /** People without an account may talk to the default model. */
  guests: boolean
}
