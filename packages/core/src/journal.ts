// Conversation journal format.

export type Trust = 'owner' | 'known' | 'untrusted'

/** Where an input comes from. */
export type Origin = { channel: string; author?: string; trust: Trust }

/** Whom an output is addressed to. */
export type Destination = { channel: string; recipient?: string }

export type Part =
  | { type: 'text'; text: string }
  | { type: 'file'; uri: string; mediaType: string; sha256: string }

export type Meta = Record<string, unknown>

export type ItemStatus = 'streaming' | 'done' | 'interrupted' | 'failed'

export type EventName =
  | 'interrupted'
  | 'compacted'
  | 'approval'
  | 'tools_changed'
  | 'branch_resumed'
  | 'wakeup_scheduled'
  | 'wakeup_fired'
  | 'wakeup_cancelled'
  | 'regenerate'
  /** An allowed tool call is delegated to the client that runs it (`data: { callId }`). */
  | 'handed'

export type ItemBody =
  | { kind: 'user_message'; parts: Part[]; from?: Origin }
  | { kind: 'external_event'; source: string; name: string; data: unknown; trust: Trust }
  | { kind: 'assistant_text'; text: string; audience: 'user' | 'private'; to?: Destination }
  | { kind: 'reasoning'; text?: string; opaque?: { provider: string; data: unknown } }
  | {
      kind: 'tool_call'
      callId: string
      tool: string
      input: unknown
      channel: 'environment' | 'user'
      to?: Destination
    }
  | {
      kind: 'tool_result'
      callId: string
      output: Part[]
      isError?: boolean
      as?: 'tool' | 'user'
      from?: Origin
    }
  | { kind: 'event'; name: EventName; data: unknown }

type ItemHeader = {
  id: string
  parentId: string | null
  seq: number
  at: string
  status: ItemStatus
  meta?: Meta
}

export type Item = ItemHeader & ItemBody

/** An item not yet persisted: the `Store` assigns its `seq`. */
export type ItemDraft = Omit<ItemHeader, 'seq'> & ItemBody

export type Wakeup = { id: string; at: string; every?: string; payload: unknown }

export type Log = { schema: 1; items: Item[] }
