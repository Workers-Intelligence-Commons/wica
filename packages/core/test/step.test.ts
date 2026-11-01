import { describe, expect, it } from 'vite-plus/test'

import {
  type Event,
  initialState,
  type Intent,
  type Item,
  type ItemDraft,
  journalViolations,
  pathTo,
  settled,
  type State,
  step,
  type ToolSpec,
} from '../src/index.ts'

type Body = Event extends infer E ? (E extends unknown ? Omit<E, 'at'> : never) : never

const tools: ToolSpec[] = [
  { name: 'read_file', description: '', inputSchema: {}, channel: 'environment' },
  { name: 'ask_user', description: '', inputSchema: {}, channel: 'user', speaker: 'user' },
]

/** Minimal host: acknowledges each `persist` as a Store would, and collects the intents. */
function host(init?: Partial<Parameters<typeof initialState>[0]>) {
  let state = initialState({ conversationId: 'c', salt: 's', ...init })
  let seq = state.maxSeq
  let clock = 0
  const log: Intent[] = []
  const send = (body: Body): Intent[] => {
    const r = step(state, { ...body, at: `t${clock++}` } as Event)
    state = r.state
    log.push(...r.intents)
    for (const i of r.intents) {
      if (i.t === 'persist') {
        state = step(state, {
          t: 'persisted',
          items: i.items.map((d) => ({ id: d.id, seq: ++seq })),
          at: `t${clock++}`,
        }).state
      }
    }
    return r.intents
  }
  send({ t: 'tools_changed', tools })
  return {
    send,
    get state(): State {
      return state
    },
    log,
  }
}

const kinds = (intents: Intent[]) => intents.map((i) => i.t)
const journal = (s: State) => pathTo(s.items, s.head)

describe('step', () => {
  it('asks for a model call after a message, preceded by the tool snapshot', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Hello' }] })
    const message = h.state.head
    const intents = h.send({ t: 'resume' })
    expect(kinds(intents)).toEqual(['persist', 'call_model'])
    expect((intents[0] as Extract<Intent, { t: 'persist' }>).items[0]).toMatchObject({
      kind: 'event',
      name: 'tools_changed',
      data: { tools },
    })
    const call = intents[1] as Extract<Intent, { t: 'call_model' }>
    expect(call.request.trigger).toBe(message)
    expect(call.request.path.map((i) => i.kind)).toEqual(['user_message', 'event'])
    expect(call.request.tools).toEqual(tools)
  })

  it('writes the streaming text then settles it, and promotes the text of a response without a tool', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Hello' }] })
    h.send({ t: 'resume' })
    const first = h.send({ t: 'model_delta', delta: { type: 'text', text: 'H' } })
    expect(kinds(first)).toEqual(['persist', 'append_delta'])
    expect((first[0] as Extract<Intent, { t: 'persist' }>).items[0]?.status).toBe('streaming')
    expect(kinds(h.send({ t: 'model_delta', delta: { type: 'text', text: 'i' } }))).toEqual([
      'append_delta',
    ])
    const done = h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'Hi' }] } })
    expect(kinds(done)).toEqual(['settle'])
    const reply = journal(h.state).at(-1)
    expect(reply).toMatchObject({
      kind: 'assistant_text',
      text: 'Hi',
      audience: 'user',
      status: 'done',
      meta: { promoted: true },
    })
    expect(kinds(h.send({ t: 'resume' }))).toEqual([])
  })

  it('keeps private the text that precedes tool calls, then starts the tool', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Read a.txt' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: {
        parts: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_call', callId: 'k1', tool: 'read_file', input: { path: 'a.txt' } },
        ],
      },
    })
    const path = journal(h.state)
    expect(path.at(-2)).toMatchObject({ kind: 'assistant_text', audience: 'private' })
    expect(path.at(-1)).toMatchObject({ kind: 'tool_call', channel: 'environment' })
    expect(h.send({ t: 'resume' })).toEqual([
      {
        t: 'run_tool',
        call: { callId: 'k1', tool: 'read_file', input: { path: 'a.txt' }, channel: 'environment' },
      },
    ])
    h.send({ t: 'tool_result', callId: 'k1', output: [{ type: 'text', text: 'content' }] })
    expect(kinds(h.send({ t: 'resume' }))).toEqual(['call_model'])
    expect(journalViolations(h.state.items)).toEqual([])
  })

  it('waits for the person on a user channel call, and returns their answer as their speech', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Tidy up' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: {
        parts: [{ type: 'tool_call', callId: 'q1', tool: 'ask_user', input: { q: 'Where?' } }],
      },
    })
    expect(kinds(h.send({ t: 'resume' }))).toEqual(['ask_user'])
    h.send({
      t: 'tool_result',
      callId: 'q1',
      output: [{ type: 'text', text: 'In /tmp' }],
      from: { channel: 'web', author: 'alice', trust: 'owner' },
    })
    expect(journal(h.state).at(-1)).toMatchObject({ kind: 'tool_result', as: 'user' })
  })

  it('settles as interrupted a stream left open by a lost turn, keeping its text', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Hello' }] })
    h.send({ t: 'resume' })
    h.send({ t: 'model_delta', delta: { type: 'text', text: 'Start' } })
    // The next turn rebuilds its state from the Store, where the item stayed in streaming.
    const stored: Item[] = h.state.items.map((i) =>
      i.kind === 'assistant_text' ? { ...i, text: 'Start' } : i,
    )
    const next = host({ items: stored, head: h.state.head })
    const intents = next.send({ t: 'resume' })
    expect(kinds(intents)).toEqual(['settle'])
    expect((intents[0] as { item: ItemDraft }).item).toMatchObject({
      status: 'interrupted',
      text: 'Start',
      audience: 'user',
    })
  })

  // The person saw this text being written: interrupted, it stays theirs, and the screen shows it.
  it('addresses the text of an interrupted response to the person', () => {
    for (const freeText of ['user_tool', 'direct'] as const) {
      const h = host({ policy: { freeText } })
      h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Hello' }] })
      h.send({ t: 'resume' })
      h.send({ t: 'model_delta', delta: { type: 'text', text: 'Start' } })
      h.send({ t: 'interrupt' })
      expect(journal(h.state).find((i) => i.kind === 'assistant_text')).toMatchObject({
        status: 'interrupted',
        text: 'Start',
        audience: 'user',
      })
    }
  })

  it('interrupts cleanly: stream settled and an error result for each call without a result', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Read' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: { parts: [{ type: 'tool_call', callId: 'k1', tool: 'read_file', input: {} }] },
    })
    h.send({ t: 'interrupt' })
    const path = journal(h.state)
    expect(path.at(-2)).toMatchObject({ kind: 'tool_result', callId: 'k1', isError: true })
    expect(path.at(-1)).toMatchObject({ kind: 'event', name: 'interrupted' })
    expect(kinds(h.send({ t: 'resume' }))).toEqual([])
    expect(journalViolations(h.state.items)).toEqual([])
  })

  it('does not duplicate a message sent again identically', () => {
    const h = host()
    const msg: Body = {
      t: 'user_message',
      parentId: null,
      parts: [{ type: 'text', text: 'Hello' }],
    }
    h.send(msg)
    expect(h.send(msg)).toEqual([])
    expect(h.state.items.filter((i) => i.kind === 'user_message')).toHaveLength(1)
  })

  it('replays deterministically, including after a JSON serialization of the state', () => {
    const events: Body[] = [
      { t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Read' }] },
      { t: 'resume' },
      { t: 'model_delta', delta: { type: 'text', text: 'Read' } },
      { t: 'model_delta', delta: { type: 'text', text: 'ing.' } },
      {
        t: 'model_done',
        message: {
          parts: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_call', callId: 'k1', tool: 'read_file', input: { path: 'a' } },
          ],
        },
      },
      { t: 'resume' },
      { t: 'tool_result', callId: 'k1', output: [{ type: 'text', text: 'x' }] },
      { t: 'resume' },
    ]
    const run = (roundTrip: boolean) => {
      let state = initialState({ conversationId: 'c', salt: 's' })
      const out: unknown[] = []
      events.forEach((body, n) => {
        if (roundTrip) state = JSON.parse(JSON.stringify(state)) as State
        const r = step(state, { ...body, at: `t${n}` } as Event)
        state = r.state
        out.push(r.intents)
      })
      return { out, state }
    }
    expect(run(true)).toEqual(run(false))
  })
})

describe('settled', () => {
  // A client knows that the server owes nothing more to the conversation, without waiting for a
  // signal that can be missed between two turns of the same message.
  it('follows the work the journal still waits for, until the final response', () => {
    const h = host()
    const now = () => settled(h.state.items, h.state.head)
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Read a.txt' }] })
    expect(now()).toBe(false)
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: { parts: [{ type: 'tool_call', callId: 'k1', tool: 'read_file', input: {} }] },
    })
    expect(now()).toBe(false)
    h.send({ t: 'tool_result', callId: 'k1', output: [{ type: 'text', text: 'content' }] })
    expect(now()).toBe(false)
    h.send({ t: 'resume' })
    h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'There.' }] } })
    expect(now()).toBe(true)
  })

  it('keeps the error of a model that fails before any text, and stays at rest', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Hi' }] })
    h.send({ t: 'resume' })
    h.send({ t: 'model_failed', error: '404: no endpoint' })
    expect(journal(h.state).at(-1)).toMatchObject({
      kind: 'event',
      name: 'model_failed',
      data: { error: '404: no endpoint' },
    })
    expect(settled(h.state.items, h.state.head)).toBe(true)
    expect(kinds(h.send({ t: 'resume' }))).toEqual([])
    expect(journalViolations(h.state.items)).toEqual([])
  })

  it('keeps the text received before a model failure, marked as failed', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Hi' }] })
    h.send({ t: 'resume' })
    h.send({ t: 'model_delta', delta: { type: 'text', text: 'Hel' } })
    h.send({ t: 'model_failed', error: 'connection reset' })
    const path = journal(h.state)
    expect(path.at(-2)).toMatchObject({ kind: 'assistant_text', text: 'Hel', status: 'failed' })
    expect(path.at(-1)).toMatchObject({ kind: 'event', name: 'model_failed' })
  })

  it('is at rest after an interruption, which closes the open calls', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Read' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: { parts: [{ type: 'tool_call', callId: 'k1', tool: 'read_file', input: {} }] },
    })
    h.send({ t: 'interrupt' })
    expect(settled(h.state.items, h.state.head)).toBe(true)
  })
})
