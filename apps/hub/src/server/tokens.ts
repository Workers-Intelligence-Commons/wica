// People's model tokens as pi-ai reads them, over the rows of the storage: the instance key
// encrypts them, and `modify`, which refreshes a token, runs under the lease of its row.

import type { CredentialStore as PiCredentialStore } from '@earendil-works/pi-ai'

import { decrypt, encrypt, type InstanceKey } from './crypto.ts'
import type { ModelTokenRows, PiCredential, SealedSecret } from './data.ts'
import { underLease } from './lease.ts'

/** A person's model tokens, as pi-ai reads them. */
export type PersonTokens = PiCredentialStore & {
  /** True the first time only: the subscription warning is given only once. */
  markWarned(provider: string): Promise<boolean>
}

export interface ModelTokens {
  forUser(userId: string): PersonTokens
}

export function modelTokens(rows: ModelTokenRows, key: Promise<InstanceKey>): ModelTokens {
  const open = async (secret: SealedSecret) =>
    JSON.parse(await decrypt(await key, secret)) as PiCredential
  const seal = async (credential: PiCredential) => encrypt(await key, JSON.stringify(credential))

  return {
    forUser: (userId) => ({
      async read(provider) {
        const secret = await rows.current(userId, provider)
        return secret ? open(secret) : undefined
      },
      list: () => rows.list(userId),
      async modify(provider, fn) {
        for (;;) {
          const result = await underLease(
            (until, now) => rows.lease(userId, provider, until, now),
            async (held, until) => {
              let current: PiCredential
              let next: PiCredential | undefined
              try {
                current = await open(held.secret)
                next = await fn(current)
              } catch (error) {
                await rows.release(held.id, until)
                throw error
              }
              if (next === undefined) {
                await rows.release(held.id, until)
                return current
              }
              await rows.release(held.id, until, { secret: await seal(next), type: next.type })
              return next
            },
          )
          if (result !== 'missing') return result
          const next = await fn(undefined)
          if (next === undefined) return undefined
          // Another request connected this provider first: its token goes through `fn` again.
          if (await rows.insert(userId, provider, next.type, await seal(next))) return next
        }
      },
      delete: (provider) => rows.revoke(userId, provider),
      markWarned: (provider) => rows.markWarned(userId, provider),
    }),
  }
}
