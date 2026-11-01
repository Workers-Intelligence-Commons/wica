// MCP connections: the package initializes the connection to each server configured by the host,
// negotiates the version, exposes its tools as `Tool`s, reconnects after a disconnection, and
// never lets a broken connection make a turn fail.
// This file uses only standard web APIs; launching local servers is in `./node`.

import {
  Client,
  type ElicitRequestParams,
  type ElicitResult,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client'
import type { Part, ToolAnnotations } from '@wica/core'
import type { CredentialStore, Tool, ToolContext } from '@wica/runtime'

export type McpServerConfig = {
  /** Server name: it prefixes its tools (`<name>__<tool>`). */
  name: string
  /** HTTP address of the server (Streamable HTTP transport). */
  url?: string
  /** Transport provided by the host, for example `stdioServer` from `./node`; takes priority over `url`. */
  transport?: () => Transport
  /**
   * Identifier of the server in the host `CredentialStore`: the token is read at each request and
   * sent in `Authorization: Bearer`, never taken from the configuration or from the journal.
   */
  credential?: { store: CredentialStore; key: string }
  headers?: Record<string, string>
  /** Allowed tools; absent: all of them. */
  allow?: string[]
  /** Refused tools, applied after `allow`. */
  deny?: string[]
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type McpOptions = {
  /** Identity announced to the servers. */
  clientInfo?: { name: string; version: string }
  /** Base `fetch` of the HTTP connections; the host may restrict the addresses it reaches. */
  fetch?: Fetch
}

/** Default values of the annotations in the MCP specification. */
const DEFAULT_ANNOTATIONS: Required<Omit<ToolAnnotations, 'title'>> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

/**
 * Annotations completed with the default values. MCP gives `destructiveHint` a meaning only for a
 * tool that writes: a read-only tool is therefore never destructive.
 */
export function annotations(declared: ToolAnnotations = {}): ToolAnnotations {
  const merged = { ...DEFAULT_ANNOTATIONS, ...declared }
  if (merged.readOnlyHint) merged.destructiveHint = false
  return merged
}

const SEPARATOR = '__'

type McpTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: ToolAnnotations
}

type Content =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function dataPart(data: string, mediaType: string): Promise<Part> {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes))
  return { type: 'file', uri: `data:${mediaType};base64,${data}`, mediaType, sha256 }
}

/** Content of an MCP result, turned into journal parts. */
export async function toParts(result: {
  content?: unknown[]
  structuredContent?: unknown
}): Promise<Part[]> {
  const parts: Part[] = []
  for (const block of (result.content ?? []) as Content[]) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text })
        break
      case 'image':
      case 'audio':
        parts.push(await dataPart(block.data, block.mimeType))
        break
      case 'resource_link':
        parts.push({ type: 'text', text: `Resource: ${block.name ?? block.uri} (${block.uri})` })
        break
      case 'resource':
        if (block.resource.text !== undefined)
          parts.push({ type: 'text', text: block.resource.text })
        else if (block.resource.blob !== undefined) {
          parts.push(
            await dataPart(
              block.resource.blob,
              block.resource.mimeType ?? 'application/octet-stream',
            ),
          )
        }
        break
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
  }
  return parts
}

/**
 * Requests to an MCP server with its token. A `401` refusal makes the token refresh once, under
 * the mutual exclusion of the `CredentialStore`, then replays the request.
 */
export function authorizedFetch(
  base: Fetch,
  credential: { store: CredentialStore; key: string } | undefined,
  headers: Record<string, string> = {},
): Fetch {
  const attempt = (
    input: string | URL | Request,
    init: RequestInit | undefined,
    token?: string,
  ) => {
    const h = new Headers(init?.headers)
    for (const [k, v] of Object.entries(headers)) h.set(k, v)
    if (token) h.set('authorization', `Bearer ${token}`)
    return base(input, { ...init, headers: h })
  }
  return async (input, init) => {
    const current = credential && (await credential.store.get(credential.key))
    const response = await attempt(input, init, current?.token)
    if (response.status !== 401 || !credential || !current) return response
    const fresh = await credential.store.refresh(credential.key, current.token)
    if (!fresh || fresh.token === current.token) return response
    return attempt(input, init, fresh.token)
  }
}

/** A broken connection: the affected tool returns an error result. */
export class McpConnectionError extends Error {
  override name = 'McpConnectionError'
}

class Connection {
  readonly config: McpServerConfig
  readonly #options: McpOptions
  #client: Client | null = null
  #connecting: Promise<Client> | null = null
  #tools: McpTool[] = []
  #closed = false
  /** Calls in progress: an information request goes to the most recent one. */
  readonly #running: ToolContext[] = []

  constructor(config: McpServerConfig, options: McpOptions) {
    this.config = config
    this.#options = options
  }

  get tools(): McpTool[] {
    return this.#tools
  }

  #transport(): Transport {
    if (this.config.transport) return this.config.transport()
    if (!this.config.url)
      throw new McpConnectionError(`MCP server ${this.config.name} has no address`)
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      fetch: authorizedFetch(
        this.#options.fetch ?? fetch,
        this.config.credential,
        this.config.headers,
      ),
    })
  }

  async #elicit(params: ElicitRequestParams): Promise<ElicitResult> {
    const ctx = this.#running.at(-1)
    if (!ctx) return { action: 'decline' }
    const answer = (await ctx.ask({ server: this.config.name, ...params })) as ElicitResult
    return answer && typeof answer === 'object' && 'action' in answer
      ? answer
      : { action: 'decline' }
  }

  /** Connection, on demand; only one attempt at a time. */
  async client(): Promise<Client> {
    if (this.#closed) throw new McpConnectionError(`MCP server ${this.config.name} closed`)
    if (this.#client) return this.#client
    if (this.#connecting) return this.#connecting
    this.#connecting = (async () => {
      const client = new Client(this.#options.clientInfo ?? { name: 'wica', version: '0.0.0' }, {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error || !tools) return
              // Read at the next turn by `tools()`; the core then writes `tools_changed`.
              this.#tools = tools as McpTool[]
            },
          },
        },
      })
      client.setRequestHandler('elicitation/create', (request) => this.#elicit(request.params))
      client.onclose = () => {
        if (this.#client === client) this.#client = null
      }
      try {
        await client.connect(this.#transport())
        this.#tools = (await client.listTools()).tools as McpTool[]
        if (this.#closed) throw new Error('closed during the connection')
        this.#client = client
        return client
      } catch (error) {
        await client.close().catch(() => {})
        throw new McpConnectionError(
          `Connection to the MCP server ${this.config.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.#connecting = null
      }
    })()
    return this.#connecting
  }

  /** Restarts in the background the connection of a disconnected server, without delaying the turn. */
  revive() {
    if (!this.#closed && !this.#client && !this.#connecting)
      void this.client().catch(() => undefined)
  }

  async call(name: string, input: unknown, ctx: ToolContext): Promise<Part[]> {
    this.#running.push(ctx)
    try {
      // A connection dropped between two calls is reopened here; a second disconnection during
      // the call becomes an error result, without a retry: the effect may have happened.
      const client = await this.client()
      let result
      try {
        result = await client.callTool(
          { name, arguments: (input ?? {}) as Record<string, unknown> },
          { signal: ctx.signal },
        )
      } catch (error) {
        throw new McpConnectionError(
          `MCP call ${this.config.name}/${name} interrupted: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const parts = await toParts(result)
      if (result.isError) {
        throw new Error(
          parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') || 'MCP error.',
        )
      }
      return parts
    } finally {
      this.#running.splice(this.#running.indexOf(ctx), 1)
    }
  }

  async close() {
    this.#closed = true
    await this.#client?.close().catch(() => {})
    this.#client = null
  }
}

export type McpConnections = {
  /** Tools of all reachable servers, in a stable order. */
  tools(): Tool[]
  close(): Promise<void>
}

function allowed(config: McpServerConfig, name: string) {
  if (config.allow && !config.allow.includes(name)) return false
  return !config.deny?.includes(name)
}

/**
 * Connects the configured servers. An unreachable server does not block the others: each
 * `tools()` restarts its connection in the background, and its tools appear at the turn that
 * follows a successful connection.
 */
export async function connectMcp(
  servers: McpServerConfig[],
  options: McpOptions = {},
): Promise<McpConnections> {
  const connections = servers.map((config) => new Connection(config, options))
  await Promise.all(connections.map((c) => c.client().catch(() => undefined)))
  return {
    tools: () =>
      connections.flatMap((connection) => {
        connection.revive()
        return connection.tools
          .filter((t) => allowed(connection.config, t.name))
          .map((t): Tool => ({
            spec: {
              name: `${connection.config.name}${SEPARATOR}${t.name}`,
              description: t.description ?? t.name,
              inputSchema: t.inputSchema,
              annotations: annotations(t.annotations),
              channel: 'environment',
            },
            run: (input, ctx) => connection.call(t.name, input, ctx),
          }))
      }),
    close: async () => {
      await Promise.all(connections.map((c) => c.close()))
    },
  }
}
