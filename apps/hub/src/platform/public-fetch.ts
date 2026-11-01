// Node `fetch` restricted to public addresses, for the servers that people add. The address is
// checked again at each connection: a name that resolves to an internal address, or a redirect
// toward one, is refused too.

import { type LookupAddress, lookup } from 'node:dns'
import { Agent, buildConnector } from 'undici'

import { AddressRefused, ipProblem, publicOnly } from '../server/addresses.ts'

type LookupCallback = (
  error: Error | null,
  address: string | LookupAddress[],
  family?: number,
) => void

/** Name resolution that fails when any address of the name is not public. */
export function publicLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
) {
  lookup(hostname, { family: options.family ?? 0, all: true }, (error, addresses) => {
    if (error) return callback(error, [])
    const refused = addresses.find((a) => ipProblem(a.address))
    if (refused) {
      const problem = ipProblem(refused.address)
      return callback(new AddressRefused(`${hostname} resolves to ${problem}`), [])
    }
    const [first] = addresses
    if (options.all) return callback(null, addresses)
    if (!first) return callback(new AddressRefused(`${hostname} has no address`), [])
    return callback(null, first.address, first.family)
  })
}

const connect = buildConnector({ lookup: publicLookup } as buildConnector.BuildOptions)

/** Connections of the servers that people add: an IP address is checked before connecting. */
export const publicAgent = new Agent({
  connect: (options, callback) => {
    const problem = ipProblem(options.hostname.replace(/^\[|\]$/g, ''))
    if (problem) {
      callback(new AddressRefused(`${options.hostname} is ${problem}`), null)
      return
    }
    connect(options, callback)
  },
})

export const publicFetch = publicOnly((input, init) =>
  fetch(input, { ...init, dispatcher: publicAgent } as RequestInit),
)
