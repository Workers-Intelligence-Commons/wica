// The API keys of the account, in the settings: a script sends one in `Authorization: Bearer` and
// acts as the account, without the admin role. A new key is shown once; the hub keeps only its
// hash.

import { Button, Notice, SectionHeading, Skeleton } from '@workers-intelligence-commons/components'
import { useCallback, useEffect, useState } from 'react'

type Key = { id: string; createdAt: string }

export function ApiKeys() {
  const [keys, setKeys] = useState<Key[] | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const reload = useCallback(() => {
    void fetch('/api/keys')
      .then((r) => r.json() as Promise<Key[]>)
      .then(setKeys)
  }, [])
  useEffect(reload, [reload])

  async function create() {
    const response = await fetch('/api/keys', { method: 'POST' })
    if (response.ok) setCreated(((await response.json()) as { token: string }).token)
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
        {(keys ?? []).map((key) => (
          <li key={key.id} className="provider">
            <div className="inline">
              <span className="row-name">
                Key created {new Date(key.createdAt).toLocaleString()}
              </span>
              <Button
                variant="quiet"
                onClick={() => void fetch(`/api/keys/${key.id}`, { method: 'DELETE' }).then(reload)}
              >
                Revoke
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Button onClick={() => void create()}>Create a key</Button>
    </section>
  )
}
