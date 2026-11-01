import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { addressProblem, publicOnly } from '../src/server/addresses.ts'
import { publicAgent, publicLookup } from '../src/platform/public-fetch.ts'

describe('addresses of the servers that people add', () => {
  // A person's server address must never reach the instance's own network: its loopback, the
  // private ranges, the cloud metadata address, or the same written another way.
  it('refuses internal addresses in every written form, and accepts public ones', () => {
    for (const internal of [
      'http://localhost:3000/mcp',
      'http://app.localhost/',
      'http://printer.local/',
      'http://metadata.google.internal/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://10.1.2.3/',
      'http://172.20.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[64:ff9b::a00:1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://user:pass@example.org/',
      'file:///etc/passwd',
    ]) {
      expect(addressProblem(internal), internal).not.toBeNull()
    }
    for (const external of [
      'https://mcp.example.org/mcp',
      'https://93.184.216.34/',
      'https://[2606:4700::1111]/',
      'http://172.32.0.1/',
    ]) {
      expect(addressProblem(external), external).toBeNull()
    }
  })
})

describe('the address check of every request', () => {
  // On Workers the address check is the only guard: a public server must not lead the hub, by a
  // redirect, to an internal address.
  it('follows a redirect to a public address and refuses one to an internal address', async () => {
    const reached: string[] = []
    const guarded = publicOnly(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      reached.push(url)
      if (url === 'https://mcp.example.org/a') {
        return new Response(null, { status: 302, headers: { location: '/b' } })
      }
      if (url === 'https://mcp.example.org/b') {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
      }
      return new Response('reached')
    })

    expect(await (await guarded('https://mcp.example.org/b2')).text()).toBe('reached')
    await expect(guarded('https://mcp.example.org/a')).rejects.toMatchObject({
      name: 'AddressRefused',
    })
    expect(reached).toEqual([
      'https://mcp.example.org/b2',
      'https://mcp.example.org/a',
      'https://mcp.example.org/b',
    ])
  })
})

describe('Node connections to the servers that people add', () => {
  let server: ReturnType<typeof createServer>
  let port = 0
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('reached'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  // A redirect or a name can lead past the check of the written address: the connection itself
  // must refuse an internal address.
  it('refuses to connect to an internal address, whatever led there', async () => {
    const direct = fetch(`http://127.0.0.1:${port}/`, { dispatcher: publicAgent } as RequestInit)
    await expect(direct).rejects.toMatchObject({ cause: { name: 'AddressRefused' } })
    const named = await new Promise<Error | null>((resolve) =>
      publicLookup('localhost', {}, (error) => resolve(error)),
    )
    expect(named?.name).toBe('AddressRefused')
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('reached')
  })
})
