// New conversation: the first message, with the choice of the model beside it. The conversation
// is created by the API, awaited through the sync, and the message leaves right away, shown
// before its confirmation.

import { useDbClient } from '@tanstack/react-db'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ReasoningLevel } from '@wica/core'
import { Composer, Poster, SectionHeading } from '@workers-intelligence-commons/components'
import { useEffect, useState } from 'react'

import { cacheName, touchConversation } from '../../client/cache.ts'
import { conversationsCollection, itemsCollection } from '../../client/collections.ts'
import { sendMessage } from '../../client/commands.ts'
import { awaitCreated } from '../../client/sync/index.ts'
import { prepareCache } from '../../client/dependencies.ts'
import {
  keptLevel,
  levelsOf,
  ModelPicker,
  ReasoningPicker,
  useModels,
} from '../../ui/ModelPicker.tsx'
import { TopBar } from '../../ui/TopBar.tsx'

export const Route = createFileRoute('/_app/')({ component: NewConversation })

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
  const [chosenLevel, setChosenLevel] = useState<ReasoningLevel | null>(null)
  const levels = levelsOf(models, model || null)
  const level = keptLevel(chosenLevel, levels)

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
      reasoning: level,
      seq: 1,
    }).catch(() => {})
    await navigate({ to: '/c/$conversationId', params: { conversationId: created.id } })
  }

  return (
    <section className="conversation start">
      <TopBar />
      <Poster className="chat-sheet">
        <div className="start-intro">
          <SectionHeading kicker="new conversation">Start a conversation</SectionHeading>
        </div>
        <p className="failure" role="alert">
          {failed}
        </p>
        <Composer
          onSend={start}
          placeholder="Your first message"
          tools={
            <>
              <ModelPicker
                models={models}
                value={model || null}
                onChange={(m) => setModel(m ?? '')}
              />
              <ReasoningPicker levels={levels} value={level} onChange={setChosenLevel} />
            </>
          }
        />
      </Poster>
    </section>
  )
}
