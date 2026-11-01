// Client protocol: the client reads a resumable stream of items and sends commands, and the
// server answers.

import type { Item, Part, ReasoningLevel } from '@wica/core'

export const PROTOCOL_VERSION = 1

export type Command =
  | { t: 'send'; parentId: string | null; parts: Part[]; reasoning?: ReasoningLevel }
  | { t: 'answer'; callId: string; value: unknown }
  | { t: 'interrupt' }
  | { t: 'set_head'; itemId: string }
  | { t: 'regenerate'; itemId: string }

/**
 * Value of `answer` for an environment tool run by the client (files or terminal of an editor):
 * the result as it is, which stays a tool result and never the person's speech.
 */
export type ClientToolResult = { output: Part[]; isError?: boolean }

/** `commandId`: replay without duplicates; `clientSeq`: order of the commands of a client. */
export type Envelope = {
  kind: 'command'
  sessionId: string
  commandId: string
  clientSeq: number
  conversationId: string
  command: Command
}

/** Resumable read: every item whose `seq` exceeds `fromSeq`, then the live stream. */
export type Subscribe = { kind: 'subscribe'; conversationId: string; fromSeq: number }

export type ClientFrame =
  /** `sessionId`: session to resume, without new authentication if it is still valid. */
  | { kind: 'hello'; version: number; token?: string; sessionId?: string }
  | Subscribe
  | { kind: 'unsubscribe'; conversationId: string }
  /** Heartbeat: the server answers `pong`, which reveals a dead connection. */
  | { kind: 'ping' }
  | Envelope

export type ServerFrame =
  /** `resumed`: the requested session was resumed; otherwise a new one was opened. */
  | { kind: 'welcome'; version: number; sessionId: string; resumed: boolean }
  | { kind: 'items'; conversationId: string; salt: string; items: Item[] }
  | { kind: 'head'; conversationId: string; itemId: string }
  | { kind: 'delta'; conversationId: string; itemId: string; text: string }
  | { kind: 'progress'; conversationId: string; callId: string; message: string }
  | { kind: 'ack'; commandId: string; ok: true }
  | { kind: 'ack'; commandId: string; ok: false; error: string }
  | { kind: 'error'; message: string; conversationId?: string }
  | { kind: 'pong' }
  /** A turn is running for this conversation, or none anymore. */
  | { kind: 'status'; conversationId: string; running: boolean }

export type Frame = ClientFrame | ServerFrame

/**
 * Frame channel between a client and a server. At-least-once delivery, without an ordering
 * guarantee between two connections: the protocol handles the rest (identifiers, cursors).
 */
export interface Transport<Out extends Frame = Frame, In extends Frame = Frame> {
  send(frame: Out): Promise<void>
  receive(): AsyncIterable<In>
  close(): Promise<void>
}

export interface ClientTransport extends Transport<ClientFrame, ServerFrame> {
  /**
   * Transport that reconnects on its own: `listener` is called after each reconnection, so that
   * the client resumes (hello, subscriptions from its cursor, commands without acknowledgement).
   */
  onReopen?(listener: () => void): () => void
}
export type ServerTransport = Transport<ServerFrame, ClientFrame>
