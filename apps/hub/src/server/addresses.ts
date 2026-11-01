// Public addresses: a server that a person adds must be reachable on the Internet, never inside
// the network of the instance (its own loopback, the private ranges, the cloud metadata address).
// Every request of such a server's flow goes through this check, including the addresses its own
// metadata announces.

/** Why the address is refused; `null` for a public HTTP address. */
export function addressProblem(url: string | URL): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'not an address'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'not an HTTP address'
  if (parsed.username || parsed.password) return 'an address with credentials'
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return 'a local name'
  }
  return ipProblem(host)
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4Problem(a: number, b: number, c: number): string | null {
  if (a === 127) return 'a loopback address'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'a private address'
  }
  if (a === 169 && b === 254) return 'a link-local address (cloud metadata)'
  if (
    a === 0 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return 'a reserved address'
  }
  return null
}

/** The eight 16-bit groups of an IPv6 address; `null` when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dotted) {
    const [w, x, y, z] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN))
  return values.some(Number.isNaN) ? null : values
}

/** Why an IP address is not public; `null` for a public one or for a name. */
export function ipProblem(host: string): string | null {
  const v4 = IPV4.exec(host)
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number) as [number, number, number]
    return ipv4Problem(a, b, c)
  }
  if (!host.includes(':')) return null
  const g = ipv6Groups(host.toLowerCase())
  if (!g) return 'not an address'
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  // An IPv4 address carried in IPv6 (mapped, compatible, or translated by NAT64) is judged as IPv4.
  const embedded =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) ||
    (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
  if (embedded) {
    if (g5 === 0 && g0 === 0 && g6 === 0 && g7 <= 1) return 'a loopback address'
    return ipv4Problem(g6 >> 8, g6 & 0xff, g7 >> 8)
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'a private address'
  if ((g0 & 0xffc0) === 0xfe80) return 'a link-local address'
  if ((g0 & 0xff00) === 0xff00) return 'a reserved address'
  if (g0 === 0x2001 && g1 === 0x0db8) return 'a reserved address'
  return null
}

export class AddressRefused extends Error {
  override name = 'AddressRefused'
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

const refused = (url: string | URL) => {
  const problem = addressProblem(url)
  return problem ? new AddressRefused(`${String(url)} is ${problem}`) : null
}

/**
 * A `fetch` that refuses every address that is not public, before sending anything. It follows
 * the redirects itself, so that each target is checked; a redirect of a request with a body is
 * returned as it is.
 */
export const publicOnly =
  (base: Fetch): Fetch =>
  async (input, init) => {
    const request = new Request(input, init)
    let url = request.url
    for (let hop = 0; ; hop++) {
      const problem = refused(url)
      if (problem) throw problem
      const response = await base(url === request.url ? request : new Request(url, request), {
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      const replayable = request.method === 'GET' || request.method === 'HEAD'
      if (!REDIRECTS.has(response.status) || !location || !replayable) return response
      if (hop === MAX_REDIRECTS) throw new AddressRefused(`${request.url}: too many redirects`)
      url = new URL(location, url).toString()
    }
  }
