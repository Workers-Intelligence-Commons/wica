// A Rename button that becomes a field with Save and Cancel; `save` returns the problem to show,
// or null once the name is saved.

import { Button } from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

export function Rename(props: {
  label: string
  value: string
  save: (name: string) => Promise<string | null>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(props.value)
  const [failed, setFailed] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const problem = await props.save(name.trim())
    setFailed(problem)
    if (!problem) setEditing(false)
  }

  if (!editing) {
    return (
      <Button
        variant="quiet"
        onClick={() => {
          setName(props.value)
          setEditing(true)
        }}
      >
        Rename
      </Button>
    )
  }
  return (
    <form className="rename" onSubmit={(e) => void submit(e)}>
      <input
        className="wic-input wic-focus"
        aria-label={props.label}
        value={name}
        maxLength={80}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
      />
      <Button type="submit" variant="ink">
        Save
      </Button>
      <Button variant="quiet" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {failed ? (
        <p className="failure" role="alert">
          {failed}
        </p>
      ) : null}
    </form>
  )
}

/** Sends a new name; returns the server's problem, or null. */
export async function sendName(path: string, name: string): Promise<string | null> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).catch(() => null)
  if (response?.ok) return null
  const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined
  return body?.error ?? 'The name was not saved.'
}
