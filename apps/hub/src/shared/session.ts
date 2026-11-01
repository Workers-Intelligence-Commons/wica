// The session as the server reports it to the pages: `/api/me` and `/auth/mode`.

/** Sign-in mode of the hub. */
export type AuthKind = 'accounts' | 'oidc' | 'proxy'

/** Account of the request. */
export type Me = {
  id: string
  name: string
  auth: AuthKind
  /** The account has the admin role. */
  admin: boolean
}

/**
 * How the login page signs in: the mode, and whether the hub emails its accounts (confirmation
 * of the address, reset of a password).
 */
export type SignIn = { kind: AuthKind; email: boolean }
