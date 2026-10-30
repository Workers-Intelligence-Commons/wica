import { describe, expect, it } from 'vite-plus/test'

import {
  actedElsewhere,
  compactPath,
  type Event,
  initialState,
  type Intent,
  type Item,
  type ItemBody,
  journalViolations,
  parseDuration,
  pathTo,
  planWakeups,
  type State,
  step,
  type ToolSpec,
  wakeupBudgetExceeded,
  wakeupsPaused,
} from '../src/index.ts'

const tools: ToolSpec[] = [
  { name: 'schedule', description: '', inputSchema: {}, channel: 'environment' },
  { name: 'write_file', description: '', inputSchema: {}, channel: 'environment' },
  {
    name: 'read_file',
    description: '',
    inputSchema: {},
    channel: 'environment',
    annotations: { readOnlyHint: true },
  },
]

/** Journal écrit à la main : chaque élément suit le précédent, sauf parent donné. */
function journal() {
  const items: Item[] = []
  const add = (id: string, body: ItemBody, o: { parent?: string | null; at?: string } = {}) => {
    const parentId = o.parent !== undefined ? o.parent : (items.at(-1)?.id ?? null)
    items.push({
      id,
      parentId,
      seq: items.length + 1,
      at: o.at ?? '2026-10-30T10:00:00.000Z',
      status: 'done',
      ...body,
    } as Item)
    return id
  }
  return { items, add }
}

const scheduled = (id: string, at: string, every?: string): ItemBody => ({
  kind: 'event',
  name: 'wakeup_scheduled',
  data: { wakeup: { id, at, ...(every ? { every } : {}), payload: null } },
})
const fired = (id: string, at: string): ItemBody => ({
  kind: 'event',
  name: 'wakeup_fired',
  data: { id, at, payload: null },
})
const said = (text: string): ItemBody => ({ kind: 'assistant_text', text, audience: 'user' })
const ms = (iso: string) => Date.parse(iso)

describe('parseDuration', () => {
  it('lit les jours, heures, minutes et secondes, et refuse le reste', () => {
    expect(parseDuration('PT15M')).toBe(15 * 60_000)
    expect(parseDuration('P1DT2H')).toBe(26 * 3_600_000)
    expect(parseDuration('PT0.5S')).toBe(500)
    for (const bad of ['P', 'PT', '15M', 'P1W', 'PT0S']) expect(parseDuration(bad)).toBeUndefined()
  })
})

describe('planWakeups', () => {
  // Une machine endormie pendant plusieurs occurrences ne déclenche qu'un réveil, le plus récent.
  it('déclenche une seule occurrence manquée et annonce la suivante', () => {
    const j = journal()
    j.add('s', scheduled('w', '2026-10-30T10:00:00.000Z', 'PT1H'))
    const plan = planWakeups(j.items, 's', tools, ms('2026-10-30T12:30:00.000Z'))
    expect(plan).toEqual({
      due: { wakeup: expect.objectContaining({ id: 'w' }), occurrence: '2026-10-30T12:00:00.000Z' },
      next: '2026-10-30T13:00:00.000Z',
    })

    j.add('f', fired('w', '2026-10-30T12:00:00.000Z'))
    expect(planWakeups(j.items, 'f', tools, ms('2026-10-30T12:40:00.000Z'))).toEqual({
      next: '2026-10-30T13:00:00.000Z',
    })
  })

  it('ignore un réveil annulé', () => {
    const j = journal()
    j.add('s', scheduled('w', '2026-10-30T10:00:00.000Z'))
    j.add('c', { kind: 'event', name: 'wakeup_cancelled', data: { id: 'w' } })
    expect(planWakeups(j.items, 'c', tools, ms('2026-10-30T11:00:00.000Z'))).toEqual({})
  })

  it('fait attendre un réveil au-delà du plafond jusqu’à la fin de la période', () => {
    const j = journal()
    j.add('s1', scheduled('a', '2026-10-30T12:00:00.000Z'))
    j.add('f1', fired('a', '2026-10-30T12:00:00.000Z'))
    j.add('s2', scheduled('b', '2026-10-30T12:20:00.000Z'))
    const plan = planWakeups(j.items, 's2', tools, ms('2026-10-30T12:30:00.000Z'), {
      maxPerPeriod: 1,
      periodMs: 3_600_000,
    })
    expect(plan).toEqual({ next: '2026-10-30T13:00:00.000Z' })
  })
})

describe('wakeupsPaused', () => {
  const loop = (texts: string[]) => {
    const j = journal()
    j.add('m', { kind: 'user_message', parts: [{ type: 'text', text: 'Surveille' }] })
    texts.forEach((text, n) => {
      j.add(`f${n}`, fired('w', `2026-10-30T1${n}:00:00.000Z`))
      j.add(`t${n}`, said(text))
    })
    return j
  }

  it('met en pause après trois réveils de suite qui répètent la même chose', () => {
    const j = loop(['Rien de neuf.', 'Rien de neuf.', 'Rien de neuf.', 'Rien de neuf.'])
    expect(wakeupsPaused(j.items, tools)).toBe(true)
  })

  it('ne met pas en pause quand un réveil apporte du nouveau, ou après un message', () => {
    expect(
      wakeupsPaused(loop(['Rien.', 'Rien.', 'Rien.', 'Un courriel est arrivé.']).items, tools),
    ).toBe(false)
    const j = loop(['Rien.', 'Rien.', 'Rien.', 'Rien.'])
    j.add('m2', { kind: 'user_message', parts: [{ type: 'text', text: 'Continue' }] })
    expect(wakeupsPaused(j.items, tools)).toBe(false)
  })
})

describe('wakeupBudgetExceeded', () => {
  it('compte les appels au modèle depuis le réveil', () => {
    const j = journal()
    j.add('f', fired('w', '2026-10-30T10:00:00.000Z'))
    j.add('c1', {
      kind: 'tool_call',
      callId: 'k1',
      tool: 'read_file',
      input: {},
      channel: 'environment',
    })
    j.add('r1', { kind: 'tool_result', callId: 'k1', output: [] })
    expect(
      wakeupBudgetExceeded(j.items, ms('2026-10-30T10:00:01.000Z'), { maxModelCalls: 2 }),
    ).toBe(false)
    j.add('c2', {
      kind: 'tool_call',
      callId: 'k2',
      tool: 'read_file',
      input: {},
      channel: 'environment',
    })
    j.add('r2', { kind: 'tool_result', callId: 'k2', output: [] })
    expect(
      wakeupBudgetExceeded(j.items, ms('2026-10-30T10:00:01.000Z'), { maxModelCalls: 2 }),
    ).toBe(true)
    expect(
      wakeupBudgetExceeded(j.items, ms('2026-10-30T10:05:00.000Z'), { maxDurationMs: 60_000 }),
    ).toBe(true)
  })
})

describe('actedElsewhere', () => {
  // Branche A : une écriture a eu lieu. La personne édite son message : la branche B l'ignore.
  const branches = () => {
    const j = journal()
    j.add(
      'm1',
      { kind: 'user_message', parts: [{ type: 'text', text: 'Écris' }] },
      { parent: null },
    )
    j.add('w', {
      kind: 'tool_call',
      callId: 'w1',
      tool: 'write_file',
      input: {},
      channel: 'environment',
    })
    j.add('wr', { kind: 'tool_result', callId: 'w1', output: [] })
    j.add('r', {
      kind: 'tool_call',
      callId: 'r1',
      tool: 'read_file',
      input: {},
      channel: 'environment',
    })
    j.add('rr', { kind: 'tool_result', callId: 'r1', output: [] })
    j.add('m2', { kind: 'user_message', parts: [{ type: 'text', text: 'Lis' }] }, { parent: null })
    return j
  }

  it('signale une seule fois les outils qui ont agi sur une autre branche', () => {
    const j = branches()
    expect(actedElsewhere(j.items, 'm2', tools)).toEqual({ ancestor: null, callIds: ['w1'] })
    j.add('b', { kind: 'event', name: 'branch_resumed', data: { ancestor: null, callIds: ['w1'] } })
    expect(actedElsewhere(j.items, 'b', tools)).toBeUndefined()
  })
})

type Body = Event extends infer E ? (E extends unknown ? Omit<E, 'at'> : never) : never

/** Hôte minimal à horloge réglable : accuse chaque `persist` et collecte les intentions. */
function host(policy: State['policy'] = { freeText: 'direct' }) {
  let state = initialState({ conversationId: 'c', salt: 's', policy })
  let seq = 0
  let clock = '2026-10-30T10:00:00.000Z'
  const send = (body: Body): Intent[] => {
    const r = step(state, { ...body, at: clock } as Event)
    state = r.state
    for (const i of r.intents) {
      if (i.t !== 'persist') continue
      state = step(state, {
        t: 'persisted',
        items: i.items.map((d) => ({ id: d.id, seq: ++seq })),
        at: clock,
      }).state
    }
    return r.intents
  }
  send({
    t: 'tools_changed',
    tools: [...tools, { name: 'approve', description: '', inputSchema: {}, channel: 'user' }],
  })
  return {
    send,
    at: (iso: string) => void (clock = iso),
    get state() {
      return state
    },
  }
}

describe('step : réveils et échéances', () => {
  it('prévoit un réveil par l’outil schedule, puis le déclenche seul à son heure', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Rappelle-moi' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: {
        parts: [
          {
            type: 'tool_call',
            callId: 's1',
            tool: 'schedule',
            input: { inSeconds: 60, payload: 'relever la boîte' },
          },
        ],
      },
    })
    const intents = h.send({ t: 'wakeup_scheduled', callId: 's1' })
    expect(intents.filter((i) => i.t === 'schedule')).toEqual([
      { t: 'schedule', at: '2026-10-30T10:01:00.000Z' },
    ])
    h.send({ t: 'resume' })
    h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'Entendu.' }] } })

    // Trop tôt : rien ne part, l'heure du réveil est redemandée.
    h.at('2026-10-30T10:00:30.000Z')
    expect(h.send({ t: 'resume' })).toEqual([{ t: 'schedule', at: '2026-10-30T10:01:00.000Z' }])
    h.at('2026-10-30T10:01:00.000Z')
    const woke = h.send({ t: 'resume' })
    expect(woke.map((i) => i.t)).toEqual(['persist', 'call_model'])
    expect(pathTo(h.state.items, h.state.head).at(-1)).toMatchObject({
      kind: 'event',
      name: 'wakeup_fired',
      data: { id: 's1', payload: 'relever la boîte' },
    })
    // Un réveil livré deux fois ne se déclenche qu'une fois.
    h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'Rien de neuf.' }] } })
    expect(h.send({ t: 'resume' })).toEqual([])
    expect(journalViolations(h.state.items)).toEqual([])
  })

  it('refuse une approbation restée sans réponse à son échéance', () => {
    const h = host({ freeText: 'direct', approvalTimeoutMs: 60_000 })
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Écris' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: { parts: [{ type: 'tool_call', callId: 'w1', tool: 'write_file', input: {} }] },
    })
    h.send({
      t: 'approval_needed',
      callId: 'w1',
      question: 'Autoriser ?',
      to: { channel: 'telephone' },
    })
    expect(h.send({ t: 'resume' })).toEqual([
      { t: 'schedule', at: '2026-10-30T10:01:00.000Z' },
      { t: 'ask_user', question: expect.objectContaining({ callId: 'approve:w1' }) },
    ])

    h.at('2026-10-30T10:01:00.000Z')
    expect(h.send({ t: 'resume' }).map((i) => i.t)).toEqual(['persist', 'persist', 'call_model'])
    const path = pathTo(h.state.items, h.state.head)
    expect(path.find((i) => i.kind === 'tool_call' && i.tool === 'approve')).toMatchObject({
      to: { channel: 'telephone' },
    })
    expect(path.filter((i) => i.kind === 'tool_result')).toMatchObject([
      { callId: 'approve:w1', meta: { granted: false, expired: true } },
      { callId: 'w1', isError: true },
    ])
    expect(journalViolations(h.state.items)).toEqual([])
  })
})

describe('step : compaction', () => {
  it('résume le passé avant l’échange en cours, puis appelle le modèle sur la vue compactée', () => {
    const h = host({ freeText: 'direct', compaction: { maxChars: 40 } })
    h.send({
      t: 'user_message',
      parentId: null,
      parts: [{ type: 'text', text: 'Une longue première demande, bien détaillée.' }],
    })
    h.send({ t: 'resume' })
    h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'Fait.' }] } })
    const before = h.state.head
    h.send({ t: 'user_message', parentId: before, parts: [{ type: 'text', text: 'Et ensuite ?' }] })

    const [request] = h.send({ t: 'resume' }).filter((i) => i.t === 'call_model')
    expect(request?.t === 'call_model' && request.request).toMatchObject({
      tools: [],
      summarize: { from: h.state.items[0]?.id, to: before },
    })
    h.send({
      t: 'compacted',
      from: h.state.items[0]?.id ?? '',
      to: before ?? '',
      summary: 'Demande faite.',
    })

    const [answer] = h.send({ t: 'resume' }).filter((i) => i.t === 'call_model')
    expect(answer?.t === 'call_model' && answer.request.summarize).toBeUndefined()
    const view = compactPath(answer?.t === 'call_model' ? answer.request.path : [])
    expect(view[0]).toEqual({ kind: 'summary', text: 'Demande faite.' })
    expect(journalViolations(h.state.items)).toEqual([])
  })
})
