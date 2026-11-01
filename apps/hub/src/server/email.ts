// Sending of emails, for the accounts that the hub keeps: an interface that the platform
// implements with the provider of the instance. The hub contains no implementation; without one,
// addresses stay unverified and only an admin resets a password.

export type Email = { to: string; subject: string; text: string }

export interface EmailSender {
  /** Sends the email, or fails; the request that caused it then fails too. */
  send(email: Email): Promise<void>
}
