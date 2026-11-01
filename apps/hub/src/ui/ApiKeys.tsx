// The API keys of the account, in the settings: a script sends one in `Authorization: Bearer` and
// acts as the account, without the admin role. A key may carry a name that tells it apart; a new
// key is shown once, and the hub keeps only its hash.

import {
  Button,
  Notice,
  SectionHeading,
  Skeleton,
  TextInput,
} from '@workers-intelligence-commons/components'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

import { Rename, sendName } from './Rename.tsx'

type Key = { id: string; name: string; createdAt: string }

export function ApiKeys() {
  const [keys, setKeys] = useState<Key[] | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [name, setName] = useState('')
  const reload = useCallback(() => {
    void fetch('/api/keys')
      .then((r) => r.json() as Promise<Key[]>)
      .then(setKeys)
  }, [])
  useEffect(reload, [reload])

  async function create(e: FormEvent) {
    e.preventDefault()
    const response = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    })
    if (response.ok) {
      setCreated(((await response.json()) as { token: string }).token)
      setName('')
    }
    reload()
  }

  return (
    <section className="panel">
      <SectionHeading level={3} kicker="for your scripts">
        API keys
      </SectionHeading>
      {created ? (
        <div className="warning" role="alert">
          <Notice title="copy it now">
            This key is shown only once: <code>{created}</code>
          </Notice>
          <Button onClick={() => setCreated(null)}>I copied it</Button>
        </div>
      ) : null}
      {keys === null ? <Skeleton lines={2} label="Loading keys" /> : null}
      <ul className="rows">
        {(keys ?? []).map((key) => {
          const when = new Date(key.createdAt).toLocaleString()
          return (
            <li key={key.id} className="provider">
              <div className="inline">
                <span className="row-name">{key.name || `Key created ${when}`}</span>
                {key.name ? <span className="row-detail">created {when}</span> : null}
                <Rename
                  label="Name of the key"
                  value={key.name}
                  save={async (next) => {
                    const problem = await sendName(`/api/keys/${key.id}`, next)
                    if (!problem) reload()
                    return problem
                  }}
                />
                <Button
                  variant="quiet"
                  onClick={() =>
                    void fetch(`/api/keys/${key.id}`, { method: 'DELETE' }).then(reload)
                  }
                >
                  Revoke
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
      <form className="inline-form" onSubmit={(e) => void create(e)}>
        <TextInput
          id="key-name"
          label="Name (optional)"
          hint="Tells this key apart from the others, for example the script that uses it."
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit">Create a key</Button>
      </form>
    </section>
  )
}
