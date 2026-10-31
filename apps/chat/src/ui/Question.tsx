// Question posée à la personne : approbation d'un outil, `ask_user` sous ses quatre formes, ou
// demande d'un serveur MCP. La réponse part par la commande `answer`.

import { ELICIT_TOOL, type Item } from '@wica/core'
import type { AskUserAnswer, AskUserInput, ElicitAnswer } from '@wica/tools-user'
import {
  Button,
  Checkbox,
  Question as Sheet,
  Select,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

type Call = Extract<Item, { kind: 'tool_call' }>

export function Question(props: {
  call: Call
  approval: boolean
  answered: boolean
  onAnswer: (value: unknown) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const answer = async (value: unknown) => {
    setBusy(true)
    try {
      await props.onAnswer(value)
    } finally {
      setBusy(false)
    }
  }
  if (props.answered) return null
  if (props.approval) {
    const input = props.call.input as { question?: string }
    return (
      <Sheet
        from="approval needed"
        question={input.question ?? `Allow ${props.call.tool}?`}
        actions={
          <>
            <Button variant="primary" disabled={busy} onClick={() => void answer(true)}>
              Allow
            </Button>
            <Button disabled={busy} onClick={() => void answer(false)}>
              Refuse
            </Button>
          </>
        }
      />
    )
  }
  if (props.call.tool === ELICIT_TOOL) {
    return <Elicit call={props.call} busy={busy} answer={answer} />
  }
  return <AskUser input={props.call.input as AskUserInput} busy={busy} answer={answer} />
}

function AskUser(props: {
  input: AskUserInput
  busy: boolean
  answer: (v: AskUserAnswer) => Promise<void>
}) {
  const { input, busy, answer } = props
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})

  if (input.kind === 'confirm') {
    return (
      <Sheet
        question={input.question}
        actions={
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void answer({ kind: 'confirm', yes: true })}
            >
              Yes
            </Button>
            <Button disabled={busy} onClick={() => void answer({ kind: 'confirm', yes: false })}>
              No
            </Button>
          </>
        }
      />
    )
  }
  if (input.kind === 'choice') {
    return (
      <Sheet question={input.question}>
        <ul className="options">
          {input.options.map((o) => (
            <li key={o.label}>
              <button
                type="button"
                className="option wic-focus"
                disabled={busy}
                onClick={() => void answer({ kind: 'choice', label: o.label })}
              >
                {o.label}
                {o.description ? <span>{o.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    )
  }
  if (input.kind === 'multiple') {
    return (
      <Sheet
        question={input.question}
        onSubmit={(e) => {
          e.preventDefault()
          void answer({ kind: 'multiple', labels: picked })
        }}
        actions={
          <Button type="submit" variant="primary" disabled={busy}>
            Answer
          </Button>
        }
      >
        {input.options.map((o) => (
          <Checkbox
            key={o.label}
            label={o.label}
            hint={o.description}
            checked={picked.includes(o.label)}
            onChange={(e) =>
              setPicked((p) =>
                e.target.checked ? [...p, o.label] : p.filter((l) => l !== o.label),
              )
            }
          />
        ))}
      </Sheet>
    )
  }
  if (input.kind === 'text') {
    return (
      <Sheet
        question={input.question}
        onSubmit={(e) => {
          e.preventDefault()
          void answer({ kind: 'text', text })
        }}
        actions={
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            Answer
          </Button>
        }
      >
        <TextInput
          label="Your answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={input.placeholder}
        />
      </Sheet>
    )
  }
  if (input.kind !== 'form') return null
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void answer({ kind: 'form', values })
  }
  return (
    <Sheet
      question={input.question}
      onSubmit={submit}
      actions={
        <Button type="submit" variant="primary" disabled={busy}>
          Answer
        </Button>
      }
    >
      {input.fields.map((f) =>
        f.type === 'boolean' ? (
          <Checkbox
            key={f.name}
            label={f.label}
            checked={values[f.name] === true}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
          />
        ) : f.type === 'choice' ? (
          <Select
            key={f.name}
            label={f.label}
            required={f.required}
            value={String(values[f.name] ?? '')}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
          >
            <option value="" />
            {(f.options ?? []).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        ) : (
          <TextInput
            key={f.name}
            label={f.label}
            type={f.type === 'number' ? 'number' : 'text'}
            required={f.required}
            value={String(values[f.name] ?? '')}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                [f.name]: f.type === 'number' ? Number(e.target.value) : e.target.value,
              }))
            }
          />
        ),
      )}
    </Sheet>
  )
}

type Field = {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
}

/** Champs simples d'un schéma de demande MCP (propriétés de premier niveau). */
function elicitFields(schema: unknown): Field[] {
  const s = schema as {
    properties?: Record<string, { type?: string; title?: string }>
    required?: string[]
  }
  return Object.entries(s?.properties ?? {}).map(([name, p]) => ({
    name,
    label: p.title ?? name,
    type:
      p.type === 'number' || p.type === 'integer'
        ? 'number'
        : p.type === 'boolean'
          ? 'boolean'
          : 'string',
    required: s.required?.includes(name) ?? false,
  }))
}

function Elicit(props: { call: Call; busy: boolean; answer: (v: ElicitAnswer) => Promise<void> }) {
  const input = props.call.input as {
    server: string
    message: string
    mode?: 'form' | 'url'
    url?: string
    requestedSchema?: unknown
  }
  const fields = input.mode === 'url' ? [] : elicitFields(input.requestedSchema)
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})
  const set = (f: Field, value: string | number | boolean) =>
    setValues((v) => ({ ...v, [f.name]: value }))
  return (
    <Sheet
      from={`asked by ${input.server}`}
      question={input.message}
      onSubmit={(e) => {
        e.preventDefault()
        void props.answer({ action: 'accept', content: values })
      }}
      actions={
        <>
          <Button type="submit" variant="primary" disabled={props.busy}>
            Answer
          </Button>
          <Button disabled={props.busy} onClick={() => void props.answer({ action: 'decline' })}>
            Refuse
          </Button>
        </>
      }
    >
      {input.mode === 'url' && input.url ? (
        <p>
          <a href={input.url} target="_blank" rel="noreferrer">
            {input.url}
          </a>
        </p>
      ) : null}
      {fields.map((f) =>
        f.type === 'boolean' ? (
          <Checkbox key={f.name} label={f.label} onChange={(e) => set(f, e.target.checked)} />
        ) : (
          <TextInput
            key={f.name}
            label={f.label}
            type={f.type === 'number' ? 'number' : 'text'}
            required={f.required}
            onChange={(e) => set(f, f.type === 'number' ? Number(e.target.value) : e.target.value)}
          />
        ),
      )}
    </Sheet>
  )
}
