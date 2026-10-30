// Connexions MCP : le paquet initialise la connexion à chaque
// serveur configuré par l'hôte, négocie la version, expose ses outils comme des `Tool`, se
// reconnecte après une coupure et ne laisse jamais une connexion cassée faire échouer un tour.
// Ce fichier n'utilise que des API web standard ; le lancement de serveurs locaux est dans `./node`.

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
  /** Nom du serveur : il préfixe ses outils (`<nom>__<outil>`). */
  name: string
  /** Adresse HTTP du serveur (transport Streamable HTTP). */
  url?: string
  /** Transport fourni par l'hôte, par exemple `stdioServer` de `./node` ; prioritaire sur `url`. */
  transport?: () => Transport
  /**
   * Identifiant du serveur dans le `CredentialStore` de l'hôte : le jeton est lu à chaque requête
   * et envoyé en `Authorization: Bearer`, jamais pris dans la configuration ni dans le journal.
   */
  credential?: { store: CredentialStore; key: string }
  headers?: Record<string, string>
  /** Outils autorisés ; absent : tous. */
  allow?: string[]
  /** Outils refusés, appliqués après `allow`. */
  deny?: string[]
}

export type McpOptions = {
  /** Identité annoncée aux serveurs. */
  clientInfo?: { name: string; version: string }
}

/** Valeurs par défaut des annotations dans la spécification MCP. */
const DEFAULT_ANNOTATIONS: Required<Omit<ToolAnnotations, 'title'>> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

/**
 * Annotations complétées par les valeurs par défaut. MCP ne donne un sens à `destructiveHint` que
 * pour un outil qui écrit : un outil en lecture seule n'est donc jamais destructif.
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

/** Contenu d'un résultat MCP vers les parties du journal. */
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
        parts.push({ type: 'text', text: `Ressource : ${block.name ?? block.uri} (${block.uri})` })
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

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Requêtes vers un serveur MCP avec son jeton. Un refus `401` fait rafraîchir le jeton une fois,
 * sous l'exclusion mutuelle du `CredentialStore`, puis rejoue la requête.
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

/** Une connexion cassée : l'outil concerné renvoie un résultat d'erreur. */
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
  /** Appels en cours : une demande d'information va au plus récent. */
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
      throw new McpConnectionError(`serveur MCP ${this.config.name} sans adresse`)
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      fetch: authorizedFetch(fetch, this.config.credential, this.config.headers),
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

  /** Connexion, à la demande ; une seule tentative à la fois. */
  async client(): Promise<Client> {
    if (this.#closed) throw new McpConnectionError(`serveur MCP ${this.config.name} fermé`)
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
              // Lu au tour suivant par `tools()` ; le cœur écrit alors `tools_changed`.
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
        if (this.#closed) throw new Error('fermé pendant la connexion')
        this.#client = client
        return client
      } catch (error) {
        await client.close().catch(() => {})
        throw new McpConnectionError(
          `Connexion au serveur MCP ${this.config.name} impossible : ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.#connecting = null
      }
    })()
    return this.#connecting
  }

  /** Relance en arrière-plan la connexion d'un serveur déconnecté, sans retarder le tour. */
  revive() {
    if (!this.#closed && !this.#client && !this.#connecting)
      void this.client().catch(() => undefined)
  }

  async call(name: string, input: unknown, ctx: ToolContext): Promise<Part[]> {
    this.#running.push(ctx)
    try {
      // Une connexion tombée entre deux appels est rouverte ici ; une seconde coupure pendant
      // l'appel devient un résultat d'erreur, sans relance : l'effet a peut-être eu lieu.
      const client = await this.client()
      let result
      try {
        result = await client.callTool(
          { name, arguments: (input ?? {}) as Record<string, unknown> },
          { signal: ctx.signal },
        )
      } catch (error) {
        throw new McpConnectionError(
          `Appel MCP ${this.config.name}/${name} interrompu : ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const parts = await toParts(result)
      if (result.isError) {
        throw new Error(
          parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') || 'Erreur MCP.',
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
  /** Outils de tous les serveurs joignables, dans un ordre stable. */
  tools(): Tool[]
  close(): Promise<void>
}

function allowed(config: McpServerConfig, name: string) {
  if (config.allow && !config.allow.includes(name)) return false
  return !config.deny?.includes(name)
}

/**
 * Connecte les serveurs configurés. Un serveur injoignable ne bloque pas les autres : chaque
 * `tools()` relance sa connexion en arrière-plan, et ses outils apparaissent au tour qui suit
 * une connexion réussie.
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
