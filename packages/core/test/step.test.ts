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

/** Hôte minimal : accuse chaque `persist` comme le ferait un Store, et collecte les intentions. */
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
  it("demande un appel au modèle après un message, précédé de l'instantané des outils", () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Bonjour' }] })
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

  it("écrit le texte en flux puis le règle, et promeut le texte d'une réponse sans outil", () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Bonjour' }] })
    h.send({ t: 'resume' })
    const first = h.send({ t: 'model_delta', delta: { type: 'text', text: 'Sal' } })
    expect(kinds(first)).toEqual(['persist', 'append_delta'])
    expect((first[0] as Extract<Intent, { t: 'persist' }>).items[0]?.status).toBe('streaming')
    expect(kinds(h.send({ t: 'model_delta', delta: { type: 'text', text: 'ut' } }))).toEqual([
      'append_delta',
    ])
    const done = h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'Salut' }] } })
    expect(kinds(done)).toEqual(['settle'])
    const reply = journal(h.state).at(-1)
    expect(reply).toMatchObject({
      kind: 'assistant_text',
      text: 'Salut',
      audience: 'user',
      status: 'done',
      meta: { promoted: true },
    })
    expect(kinds(h.send({ t: 'resume' }))).toEqual([])
  })

  it("garde privé le texte qui précède des appels d'outils, puis lance l'outil", () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Lis a.txt' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: {
        parts: [
          { type: 'text', text: 'Je regarde.' },
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
    h.send({ t: 'tool_result', callId: 'k1', output: [{ type: 'text', text: 'contenu' }] })
    expect(kinds(h.send({ t: 'resume' }))).toEqual(['call_model'])
    expect(journalViolations(h.state.items)).toEqual([])
  })

  it('attend la personne pour un appel du canal utilisateur, et rend sa réponse comme sa parole', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Range' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: {
        parts: [{ type: 'tool_call', callId: 'q1', tool: 'ask_user', input: { q: 'Où ?' } }],
      },
    })
    expect(kinds(h.send({ t: 'resume' }))).toEqual(['ask_user'])
    h.send({
      t: 'tool_result',
      callId: 'q1',
      output: [{ type: 'text', text: 'Dans /tmp' }],
      from: { channel: 'web', author: 'alice', trust: 'owner' },
    })
    expect(journal(h.state).at(-1)).toMatchObject({ kind: 'tool_result', as: 'user' })
  })

  it('règle en interrupted un flux laissé ouvert par un tour perdu, en gardant son texte', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Bonjour' }] })
    h.send({ t: 'resume' })
    h.send({ t: 'model_delta', delta: { type: 'text', text: 'Début' } })
    // Le tour suivant reconstruit son état depuis le Store, où l'élément est resté en streaming.
    const stored: Item[] = h.state.items.map((i) =>
      i.kind === 'assistant_text' ? { ...i, text: 'Début' } : i,
    )
    const next = host({ items: stored, head: h.state.head })
    const intents = next.send({ t: 'resume' })
    expect(kinds(intents)).toEqual(['settle'])
    expect((intents[0] as { item: ItemDraft }).item).toMatchObject({
      status: 'interrupted',
      text: 'Début',
      audience: 'user',
    })
  })

  // La personne a vu ce texte s'écrire : interrompu, il reste le sien, et l'écran le montre.
  it('adresse à la personne le texte d’une réponse interrompue', () => {
    for (const freeText of ['user_tool', 'direct'] as const) {
      const h = host({ policy: { freeText } })
      h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Bonjour' }] })
      h.send({ t: 'resume' })
      h.send({ t: 'model_delta', delta: { type: 'text', text: 'Début' } })
      h.send({ t: 'interrupt' })
      expect(journal(h.state).find((i) => i.kind === 'assistant_text')).toMatchObject({
        status: 'interrupted',
        text: 'Début',
        audience: 'user',
      })
    }
  })

  it("interrompt proprement : flux réglé et résultat d'erreur pour chaque appel sans résultat", () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Lis' }] })
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

  it("ne duplique pas un message renvoyé à l'identique", () => {
    const h = host()
    const msg: Body = {
      t: 'user_message',
      parentId: null,
      parts: [{ type: 'text', text: 'Bonjour' }],
    }
    h.send(msg)
    expect(h.send(msg)).toEqual([])
    expect(h.state.items.filter((i) => i.kind === 'user_message')).toHaveLength(1)
  })

  it("rejoue de façon déterministe, y compris après une sérialisation JSON de l'état", () => {
    const events: Body[] = [
      { t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Lis' }] },
      { t: 'resume' },
      { t: 'model_delta', delta: { type: 'text', text: 'Je ' } },
      { t: 'model_delta', delta: { type: 'text', text: 'lis.' } },
      {
        t: 'model_done',
        message: {
          parts: [
            { type: 'text', text: 'Je lis.' },
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
  // Un client sait que le serveur ne doit plus rien à la conversation, sans attendre un signal
  // qui peut manquer entre deux tours d'un même message.
  it('suit le travail que le journal attend encore, jusqu’à la réponse finale', () => {
    const h = host()
    const now = () => settled(h.state.items, h.state.head)
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Lis a.txt' }] })
    expect(now()).toBe(false)
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: { parts: [{ type: 'tool_call', callId: 'k1', tool: 'read_file', input: {} }] },
    })
    expect(now()).toBe(false)
    h.send({ t: 'tool_result', callId: 'k1', output: [{ type: 'text', text: 'contenu' }] })
    expect(now()).toBe(false)
    h.send({ t: 'resume' })
    h.send({ t: 'model_done', message: { parts: [{ type: 'text', text: 'Voilà.' }] } })
    expect(now()).toBe(true)
  })

  it('est au repos après une interruption, qui ferme les appels ouverts', () => {
    const h = host()
    h.send({ t: 'user_message', parentId: null, parts: [{ type: 'text', text: 'Lis' }] })
    h.send({ t: 'resume' })
    h.send({
      t: 'model_done',
      message: { parts: [{ type: 'tool_call', callId: 'k1', tool: 'read_file', input: {} }] },
    })
    h.send({ t: 'interrupt' })
    expect(settled(h.state.items, h.state.head)).toBe(true)
  })
})
