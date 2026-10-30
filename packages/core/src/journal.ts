// Format du journal de conversation.

export type Trust = 'owner' | 'known' | 'untrusted'

/** D'où vient une entrée. */
export type Origin = { channel: string; author?: string; trust: Trust }

/** À qui s'adresse une sortie. */
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
  /** Un appel d'outil autorisé est confié au client qui l'exécute (`data: { callId }`). */
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

/** Un élément pas encore persisté : le `Store` lui attribue son `seq`. */
export type ItemDraft = Omit<ItemHeader, 'seq'> & ItemBody

export type Wakeup = { id: string; at: string; every?: string; payload: unknown }

export type Log = { schema: 1; items: Item[] }
