// Minimal declaration of the Workers module used by the Workers platform: only what it calls.
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>
  export function waitUntil(promise: Promise<unknown>): void

  export type DurableObjectStorage = {
    getAlarm(): Promise<number | null>
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
    deleteAll(): Promise<void>
  }

  export type DurableObjectState = {
    storage: DurableObjectStorage
    acceptWebSocket(socket: WebSocket): void
    getWebSockets(): WebSocket[]
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
  }

  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }

  export type DurableObjectId = { toString(): string }

  /** Binding of a Durable Object class; `get` gives the stub that calls its methods. */
  export type DurableObjectNamespace<Stub> = {
    idFromName(name: string): DurableObjectId
    get(id: DurableObjectId): Stub
  }
}
