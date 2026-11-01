// New conversation: choice of the model, then the first message. The conversation is created by the API, awaited through the sync, and the message
// leaves right away, shown before its confirmation.

import { useDbClient } from '@tanstack/react-db'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Composer, SectionHeading, Select } from '@workers-intelligence-commons/components'
import { useEffect, useState } from 'react'

import { cacheName, touchConversation } from '../../client/cache.ts'
import { conversationsCollection, itemsCollection } from '../../client/collections.ts'
import { sendMessage } from '../../client/commands.ts'
import { awaitCreated } from '../../client/sync/index.ts'
import { prepareCache } from '../../client/dependencies.ts'

export const Route = createFileRoute('/_app/')({ component: NewConversation })

type ModelOption = { id: string | null; name: string }

export function useModels() {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    void fetch('/api/models')
      .then((r) => r.json() as Promise<{ default: ModelOption | null; models: ModelOption[] }>)
      .then((body) => setModels([...(body.default ? [body.default] : []), ...body.models]))
      .catch(() => setModels([]))
  }, [])
  return models
}

function NewConversation() {
  const { me } = Route.useRouteContext()
  const db = useDbClient()
  const navigate = useNavigate()
  const models = useModels()
  const [model, setModel] = useState<string>('')
  // Without a default model, the list starts with another model: the choice follows what is
  // shown, instead of sending the absent default model.
  useEffect(() => {
    if (models && !models.some((m) => (m.id ?? '') === model)) setModel(models[0]?.id ?? '')
  }, [models, model])
  const [failed, setFailed] = useState<string | null>(null)

  async function start(text: string) {
    setFailed(null)
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || null }),
    })
    if (!response.ok) {
      setFailed('The conversation could not be created.')
      return
    }
    const created = (await response.json()) as { id: string; salt: string; txid?: number }
    await awaitCreated(db.collection(conversationsCollection), created, 15_000)
    await touchConversation(me.id, created.id)
    await prepareCache(cacheName(me.id, created.id))
    const items = db.collection(itemsCollection(created.id))
    void sendMessage({
      items,
      account: me.id,
      conversationId: created.id,
      salt: created.salt,
      parentId: null,
      parts: [{ type: 'text', text }],
      seq: 1,
    }).catch(() => {})
    await navigate({ to: '/c/$conversationId', params: { conversationId: created.id } })
  }

  return (
    <section className="conversation start">
      <div className="start-intro">
        <SectionHeading kicker="new conversation">Start a conversation</SectionHeading>
      </div>
      <div className="choices">
        <Select
          label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!models}
        >
          {(models ?? []).map((m) => (
            <option key={m.id ?? ''} value={m.id ?? ''}>
              {m.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="failure" role="alert">
        {failed}
      </p>
      <Composer onSend={start} placeholder="Your first message" />
    </section>
  )
}
