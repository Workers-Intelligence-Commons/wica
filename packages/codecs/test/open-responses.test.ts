import type { Item, ItemBody, ToolSpec } from '@wica/core'
import { describe, expect, it } from 'vite-plus/test'

import {
  createOpenResponsesDecoder,
  createSseDecoder,
  toOpenResponsesRequest,
  ToolNameError,
  USER_REPLY_ACK,
} from '../src/index.ts'

let seq = 0
const item = (id: string, body: ItemBody, extra: Partial<Item> = {}): Item =>
  ({ id, parentId: null, seq: ++seq, at: 't', status: 'done', ...body, ...extra }) as Item

const spec = (name: string, channel: 'environment' | 'user' = 'environment'): ToolSpec => ({
  name,
  description: `tool ${name}`,
  inputSchema: { type: 'object' },
  channel,
})

const options = { model: 'wpt', provider: 'wic-serving' }

describe('Open Responses request', () => {
  it('returns the path in the order of the calls, speech from the person after the results, without the approvals', () => {
    const path: Item[] = [
      item('u1', { kind: 'user_message', parts: [{ type: 'text', text: 'Tidy up' }] }),
      item('r1', {
        kind: 'reasoning',
        text: 'thinking',
        opaque: { provider: 'wic-serving', data: { encrypted_content: 'abc' } },
      }),
      item('r2', {
        kind: 'reasoning',
        text: 'other provider',
        opaque: { provider: 'elsewhere', data: { encrypted_content: 'zzz' } },
      }),
      item('a1', { kind: 'assistant_text', text: 'Looking.', audience: 'private' }),
      item('c1', {
        kind: 'tool_call',
        callId: 'k1',
        tool: 'read',
        input: { p: 1 },
        channel: 'environment',
      }),
      item('c2', {
        kind: 'tool_call',
        callId: 'k2',
        tool: 'write',
        input: {},
        channel: 'environment',
      }),
      item('c3', {
        kind: 'tool_call',
        callId: 'k3',
        tool: 'ask_user',
        input: { q: '?' },
        channel: 'user',
      }),
      // Arrival out of order, with a Harness approval in the middle.
      item('x2', {
        kind: 'tool_call',
        callId: 'approve:k2',
        tool: 'approve',
        input: {},
        channel: 'user',
      }),
      item('y2', {
        kind: 'tool_result',
        callId: 'approve:k2',
        output: [{ type: 'text', text: 'Granted.' }],
        as: 'user',
      }),
      item('s3', {
        kind: 'tool_result',
        callId: 'k3',
        output: [{ type: 'text', text: 'Do B instead' }],
        as: 'user',
      }),
      item('s2', {
        kind: 'tool_result',
        callId: 'k2',
        output: [{ type: 'text', text: 'written' }],
      }),
      item('s1', {
        kind: 'tool_result',
        callId: 'k1',
        output: [{ type: 'text', text: 'content' }],
      }),
      item('e1', { kind: 'event', name: 'tools_changed', data: { tools: [] } }),
    ]
    const body = toOpenResponsesRequest(
      {
        trigger: 's1',
        path,
        tools: [spec('read'), spec('write'), spec('ask_user', 'user')],
        instructions: 'Be brief.',
      },
      options,
    )
    expect(body).toMatchObject({
      model: 'wpt',
      instructions: 'Be brief.',
      stream: true,
      store: false,
    })
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body.tools?.map((t) => t.name)).toEqual(['read', 'write', 'ask_user'])
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tidy up' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'abc' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking.' }],
      },
      { type: 'function_call', call_id: 'k1', name: 'read', arguments: '{"p":1}' },
      { type: 'function_call', call_id: 'k2', name: 'write', arguments: '{}' },
      { type: 'function_call', call_id: 'k3', name: 'ask_user', arguments: '{"q":"?"}' },
      {
        type: 'function_call_output',
        call_id: 'k1',
        output: [{ type: 'input_text', text: 'content' }],
      },
      {
        type: 'function_call_output',
        call_id: 'k2',
        output: [{ type: 'input_text', text: 'written' }],
      },
      {
        type: 'function_call_output',
        call_id: 'k3',
        output: [{ type: 'input_text', text: USER_REPLY_ACK }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do B instead' }] },
    ])
  })

  it('replaces a compacted range with its summary', () => {
    const path: Item[] = [
      item('u1', { kind: 'user_message', parts: [{ type: 'text', text: 'old' }] }),
      item('a1', { kind: 'assistant_text', text: 'old response', audience: 'user' }),
      item('k', {
        kind: 'event',
        name: 'compacted',
        data: { from: 'u1', to: 'a1', summary: 'We talked about X.' },
      }),
      item('u2', { kind: 'user_message', parts: [{ type: 'text', text: 'new' }] }),
    ]
    const body = toOpenResponsesRequest({ trigger: 'u2', path, tools: [] }, options)
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'Summary of the conversation so far:\nWe talked about X.' },
        ],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new' }] },
    ])
  })

  // The payload of a wake-up comes from the model, sometimes after an untrusted input: it must
  // never arrive with the authority of instructions.
  it('returns a wake-up as an input, not as an instruction', () => {
    const path: Item[] = [
      item('w', {
        kind: 'event',
        name: 'wakeup_fired',
        data: { id: 's1', at: '2026-10-30T10:01:00.000Z', payload: 'check the inbox' },
      }),
    ]
    const body = toOpenResponsesRequest({ trigger: 'w', path, tools: [] }, options)
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Scheduled wake-up (identifier: s1, due at 2026-10-30T10:01:00.000Z):\n"check the inbox"',
          },
        ],
      },
    ])
  })

  // The service knows efforts, not the journal's levels: each level is sent as its effort, the
  // ones the API lacks as the nearest, and the summary the host asked for stays.
  it('sends the level of the request as the effort, keeping the summary of the options', () => {
    const request = (reasoning?: 'off' | 'minimal' | 'high' | 'max') => ({
      trigger: 'u1',
      path: [item('u1', { kind: 'user_message', parts: [{ type: 'text', text: 'Hi' }] })],
      tools: [],
      ...(reasoning ? { reasoning } : {}),
    })
    const withSummary = {
      ...options,
      reasoning: { effort: 'low' as const, summary: 'auto' as const },
    }
    expect(toOpenResponsesRequest(request('high'), withSummary).reasoning).toEqual({
      effort: 'high',
      summary: 'auto',
    })
    expect(toOpenResponsesRequest(request(), withSummary).reasoning).toEqual({
      effort: 'low',
      summary: 'auto',
    })
    expect(toOpenResponsesRequest(request('off'), options).reasoning).toEqual({ effort: 'none' })
    expect(toOpenResponsesRequest(request('minimal'), options).reasoning).toEqual({ effort: 'low' })
    expect(toOpenResponsesRequest(request('max'), options).reasoning).toEqual({ effort: 'xhigh' })
  })

  it('refuses a tool name that the specification forbids', () => {
    expect(() =>
      toOpenResponsesRequest({ trigger: 'u', path: [], tools: [spec('server.tool')] }, options),
    ).toThrow(ToolNameError)
  })
})

describe('Open Responses stream', () => {
  const sse = (events: object[]) =>
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('')

  const decodeAll = (raw: string, cut: number) => {
    const s = createSseDecoder()
    const d = createOpenResponsesDecoder({ provider: 'wic-serving' })
    const out = []
    // Fixed-size chunks: an SSE message can be cut anywhere by the network.
    for (let i = 0; i < raw.length; i += cut) {
      for (const m of s.push(raw.slice(i, i + cut))) out.push(...d.push(JSON.parse(m.data)))
    }
    return out
  }

  it('returns the deltas then the final message, opaque reasoning included', () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs1',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'hmm' }],
      encrypted_content: 'E',
    }
    const msg = {
      type: 'message',
      id: 'm1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Reading.', annotations: [] }],
    }
    const call = {
      type: 'function_call',
      id: 'f1',
      call_id: 'k1',
      name: 'read',
      arguments: '{"path":"a"}',
      status: 'completed',
    }
    const raw = sse([
      { type: 'response.created', sequence_number: 0, response: {} },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { ...reasoning, content: [] },
      },
      {
        type: 'response.reasoning.delta',
        sequence_number: 2,
        item_id: 'rs1',
        output_index: 0,
        content_index: 0,
        delta: 'hmm',
      },
      { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item: reasoning },
      {
        type: 'response.output_item.added',
        sequence_number: 4,
        output_index: 1,
        item: { ...msg, content: [] },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 5,
        item_id: 'm1',
        output_index: 1,
        content_index: 0,
        delta: 'Read',
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 6,
        item_id: 'm1',
        output_index: 1,
        content_index: 0,
        delta: 'ing.',
      },
      { type: 'acme:trace', sequence_number: 7 },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: 8,
        item_id: 'f1',
        output_index: 2,
        delta: '{"pa',
      },
      {
        type: 'response.completed',
        sequence_number: 9,
        response: { output: [reasoning, msg, call] },
      },
    ])
    for (const cut of [1, 7, raw.length]) {
      expect(decodeAll(raw, cut)).toEqual([
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'Read' },
        { type: 'text', text: 'ing.' },
        {
          type: 'done',
          message: {
            parts: [
              {
                type: 'reasoning',
                text: 'hmm',
                opaque: { provider: 'wic-serving', data: { encrypted_content: 'E' } },
              },
              { type: 'text', text: 'Reading.' },
              { type: 'tool_call', callId: 'k1', tool: 'read', input: { path: 'a' } },
            ],
          },
        },
      ])
    }
  })

  it('returns the token counts of the response, the cached tokens apart from the input', () => {
    const raw = sse([
      {
        type: 'response.completed',
        sequence_number: 0,
        response: {
          output: [],
          usage: {
            input_tokens: 1200,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: 1000 },
          },
        },
      },
    ])
    expect(decodeAll(raw, raw.length)).toEqual([
      {
        type: 'done',
        message: { parts: [] },
        usage: { input: 200, output: 80, cacheRead: 1000, cacheWrite: 0 },
      },
    ])
  })

  it('returns a provider failure', () => {
    const raw = sse([
      {
        type: 'response.failed',
        sequence_number: 0,
        response: { error: { code: 'server_error', message: 'boom' } },
      },
    ])
    expect(decodeAll(raw, 3)).toEqual([{ type: 'failed', code: 'server_error', message: 'boom' }])
  })

  it('the SSE decoder follows the standard: CRLF, comments, data over several lines', () => {
    const s = createSseDecoder()
    expect(s.push(': ping\r\nevent: a\r\ndata: 1\r\ndata: 2\r')).toEqual([])
    expect(s.push('\n\r\n')).toEqual([{ event: 'a', data: '1\n2' }])
  })
})
