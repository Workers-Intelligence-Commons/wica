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
  description: `outil ${name}`,
  inputSchema: { type: 'object' },
  channel,
})

const options = { model: 'wpt', provider: 'wic-serving' }

describe('requête Open Responses', () => {
  it('rend le chemin dans l’ordre des appels, la parole de la personne après les résultats, sans les approbations', () => {
    const path: Item[] = [
      item('u1', { kind: 'user_message', parts: [{ type: 'text', text: 'Range' }] }),
      item('r1', {
        kind: 'reasoning',
        text: 'je réfléchis',
        opaque: { provider: 'wic-serving', data: { encrypted_content: 'abc' } },
      }),
      item('r2', {
        kind: 'reasoning',
        text: 'autre fournisseur',
        opaque: { provider: 'ailleurs', data: { encrypted_content: 'zzz' } },
      }),
      item('a1', { kind: 'assistant_text', text: 'Je regarde.', audience: 'private' }),
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
      // Arrivée dans le désordre, avec une approbation du Harness au milieu.
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
        output: [{ type: 'text', text: 'Accordé.' }],
        as: 'user',
      }),
      item('s3', {
        kind: 'tool_result',
        callId: 'k3',
        output: [{ type: 'text', text: 'Fais plutôt B' }],
        as: 'user',
      }),
      item('s2', { kind: 'tool_result', callId: 'k2', output: [{ type: 'text', text: 'écrit' }] }),
      item('s1', {
        kind: 'tool_result',
        callId: 'k1',
        output: [{ type: 'text', text: 'contenu' }],
      }),
      item('e1', { kind: 'event', name: 'tools_changed', data: { tools: [] } }),
    ]
    const body = toOpenResponsesRequest(
      {
        trigger: 's1',
        path,
        tools: [spec('read'), spec('write'), spec('ask_user', 'user')],
        instructions: 'Sois bref.',
      },
      options,
    )
    expect(body).toMatchObject({
      model: 'wpt',
      instructions: 'Sois bref.',
      stream: true,
      store: false,
    })
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body.tools?.map((t) => t.name)).toEqual(['read', 'write', 'ask_user'])
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Range' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'abc' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Je regarde.' }],
      },
      { type: 'function_call', call_id: 'k1', name: 'read', arguments: '{"p":1}' },
      { type: 'function_call', call_id: 'k2', name: 'write', arguments: '{}' },
      { type: 'function_call', call_id: 'k3', name: 'ask_user', arguments: '{"q":"?"}' },
      {
        type: 'function_call_output',
        call_id: 'k1',
        output: [{ type: 'input_text', text: 'contenu' }],
      },
      {
        type: 'function_call_output',
        call_id: 'k2',
        output: [{ type: 'input_text', text: 'écrit' }],
      },
      {
        type: 'function_call_output',
        call_id: 'k3',
        output: [{ type: 'input_text', text: USER_REPLY_ACK }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fais plutôt B' }] },
    ])
  })

  it('remplace une plage compactée par son résumé', () => {
    const path: Item[] = [
      item('u1', { kind: 'user_message', parts: [{ type: 'text', text: 'ancien' }] }),
      item('a1', { kind: 'assistant_text', text: 'ancienne réponse', audience: 'user' }),
      item('k', {
        kind: 'event',
        name: 'compacted',
        data: { from: 'u1', to: 'a1', summary: 'On a parlé de X.' },
      }),
      item('u2', { kind: 'user_message', parts: [{ type: 'text', text: 'nouveau' }] }),
    ]
    const body = toOpenResponsesRequest({ trigger: 'u2', path, tools: [] }, options)
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: "Résumé de la conversation jusqu'ici :\nOn a parlé de X." },
        ],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'nouveau' }] },
    ])
  })

  // La charge d'un réveil vient du modèle, parfois après une entrée non fiable : elle ne doit
  // jamais arriver avec l'autorité des consignes.
  it('rend un réveil comme une entrée, pas comme une consigne', () => {
    const path: Item[] = [
      item('w', {
        kind: 'event',
        name: 'wakeup_fired',
        data: { id: 's1', at: '2026-10-30T10:01:00.000Z', payload: 'relever la boîte' },
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
            text: 'Réveil programmé (identifiant : s1, prévu pour 2026-10-30T10:01:00.000Z) :\n"relever la boîte"',
          },
        ],
      },
    ])
  })

  it('refuse un nom d’outil que la spécification interdit', () => {
    expect(() =>
      toOpenResponsesRequest({ trigger: 'u', path: [], tools: [spec('serveur.outil')] }, options),
    ).toThrow(ToolNameError)
  })
})

describe('flux Open Responses', () => {
  const sse = (events: object[]) =>
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('')

  const decodeAll = (raw: string, cut: number) => {
    const s = createSseDecoder()
    const d = createOpenResponsesDecoder({ provider: 'wic-serving' })
    const out = []
    // Morceaux de taille fixe : un message SSE peut être coupé n'importe où par le réseau.
    for (let i = 0; i < raw.length; i += cut) {
      for (const m of s.push(raw.slice(i, i + cut))) out.push(...d.push(JSON.parse(m.data)))
    }
    return out
  }

  it('rend les deltas puis le message final, raisonnement opaque compris', () => {
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
      content: [{ type: 'output_text', text: 'Je lis.', annotations: [] }],
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
        delta: 'Je ',
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 6,
        item_id: 'm1',
        output_index: 1,
        content_index: 0,
        delta: 'lis.',
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
        { type: 'text', text: 'Je ' },
        { type: 'text', text: 'lis.' },
        {
          type: 'done',
          message: {
            parts: [
              {
                type: 'reasoning',
                text: 'hmm',
                opaque: { provider: 'wic-serving', data: { encrypted_content: 'E' } },
              },
              { type: 'text', text: 'Je lis.' },
              { type: 'tool_call', callId: 'k1', tool: 'read', input: { path: 'a' } },
            ],
          },
        },
      ])
    }
  })

  it('rend un échec du fournisseur', () => {
    const raw = sse([
      {
        type: 'response.failed',
        sequence_number: 0,
        response: { error: { code: 'server_error', message: 'boom' } },
      },
    ])
    expect(decodeAll(raw, 3)).toEqual([{ type: 'failed', code: 'server_error', message: 'boom' }])
  })

  it('le décodeur SSE suit la norme : CRLF, commentaires, données sur plusieurs lignes', () => {
    const s = createSseDecoder()
    expect(s.push(': ping\r\nevent: a\r\ndata: 1\r\ndata: 2\r')).toEqual([])
    expect(s.push('\n\r\n')).toEqual([{ event: 'a', data: '1\n2' }])
  })
})
