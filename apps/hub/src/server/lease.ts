// Refresh lease of a stored token: one holder at a time refreshes it, since a provider refuses a
// second refresh with the same refresh token. Storage takes the lease by one conditional write;
// a holder that finds it taken waits, then takes it again, and usually finds the token already
// refreshed.

/** Duration of a lease: a holder slower than this loses it to the next one. */
export const LEASE_MS = 30_000
const RECHECK_MS = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `run` under the lease of one record. `take` claims the lease until `until` when no lease
 * runs at `now`; `run` ends it. `missing` when the record does not exist.
 */
export async function underLease<Held, Result>(
  take: (until: number, now: number) => Promise<Held | 'busy' | 'missing'>,
  run: (held: Held, until: number) => Promise<Result>,
  now: () => number = Date.now,
): Promise<Result | 'missing'> {
  for (;;) {
    const start = now()
    const until = start + LEASE_MS
    const held = await take(until, start)
    if (held === 'missing') return 'missing'
    if (held === 'busy') {
      await sleep(RECHECK_MS)
      continue
    }
    return run(held, until)
  }
}
