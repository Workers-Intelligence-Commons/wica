// A conversation: the displayed path of its tree, live. The items, their batches and the measures
// of the model calls come from the synchronized collections; commands leave through the API.
// Scrolling sticks to the bottom during streaming only if the person was already there.

import { eq, useDbClient, useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { type Item, type Part, pathTo, type ReasoningLevel } from '@wica/core'
import {
  BranchSwitcher,
  Button,
  Composer,
  Message,
  MessageList,
  Poster,
  Skeleton,
  Status,
  ToolCall,
} from '@workers-intelligence-commons/components'
import { Suspense, useEffect, useRef, useState } from 'react'

import { cacheName, touchConversation } from '../../client/cache.ts'
import {
  callsCollection,
  chunksCollection,
  conversationsCollection,
  itemsCollection,
} from '../../client/collections.ts'
import { command, sendMessage } from '../../client/commands.ts'
import { prepareCache } from '../../client/dependencies.ts'
import { callDetails } from '../../client/stats.ts'
import { refreshList } from '../../client/sync/index.ts'
import { branchesOf, conversationView, leafUnder } from '../../client/view.ts'
import {
  keptLevel,
  levelsOf,
  ModelPicker,
  ReasoningPicker,
  useModels,
} from '../../ui/ModelPicker.tsx'
import { Question } from '../../ui/Question.tsx'
import { TopBar } from '../../ui/TopBar.tsx'

export const Route = createFileRoute('/_app/c/$conversationId')({
  beforeLoad: async ({ context, params }) => {
    if (import.meta.env.SSR) return
    await touchConversation(context.me.id, params.conversationId)
    await prepareCache(cacheName(context.me.id, params.conversationId))
  },
  component: ConversationPage,
})

function ConversationPage() {
  const { conversationId } = Route.useParams()
  return (
    <Suspense key={conversationId} fallback={<MessagesSkeleton />}>
      <Conversation conversationId={conversationId} />
    </Suspense>
  )
}

function MessagesSkeleton() {
  return (
    <section className="conversation">
      <TopBar />
      <Poster className="chat-sheet">
        <div className="wic-messages">
          <Skeleton lines={8} label="Loading messages" />
        </div>
      </Poster>
    </section>
  )
}

function useOnline() {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    addEventListener('online', update)
    addEventListener('offline', update)
    return () => {
      removeEventListener('online', update)
      removeEventListener('offline', update)
    }
  }, [])
  return online
}

function Conversation({ conversationId }: { conversationId: string }) {
  const { me } = Route.useRouteContext()
  const db = useDbClient()
  const items = itemsCollection(conversationId)
  const chunks = chunksCollection(conversationId)
  const calls = callsCollection(conversationId)
  const { data: conversations } = useLiveSuspenseQuery({
    query: (q) => q.from({ c: conversationsCollection }).where(({ c }) => eq(c.id, conversationId)),
  })
  const conversation = conversations[0]
  const { data: rows } = useLiveSuspenseQuery({ query: (q) => q.from({ i: items }) })
  const { data: chunkRows } = useLiveQuery({ query: (q) => q.from({ k: chunks }) })
  const { data: callRows } = useLiveQuery({ query: (q) => q.from({ m: calls }) })
  const models = useModels()
  // The model just chosen, shown until the synchronized row says it.
  const [chosenModel, setChosenModel] = useState<{ model: string | null } | null>(null)
  // The level chosen for the next messages, over the level of the last one.
  const [chosenLevel, setChosenLevel] = useState<{ level: ReasoningLevel | null } | null>(null)
  const online = useOnline()
  const [pendingHead, setPendingHead] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  if (!conversation) throw notFound()
  const knownPending = pendingHead && rows.some((r) => r.id === pendingHead) ? pendingHead : null
  const head = knownPending ?? conversation.head_item_id
  const view = conversationView(rows, chunkRows, head)
  const callOf = new Map(callRows.flatMap((c) => c.item_ids.map((id) => [id, c] as const)))
  const details = (itemId: string) => {
    const call = callOf.get(itemId)
    return call ? callDetails(call).join(' · ') : undefined
  }
  // Only the entries that appear while the page is open arrive pasted.
  const initial = useRef<Set<string> | null>(null)
  const keyOf = (entry: (typeof view.entries)[number]) =>
    entry.type === 'tool' || entry.type === 'say' || entry.type === 'question'
      ? entry.call.id
      : entry.item.id
  initial.current ??= new Set(view.entries.map(keyOf))
  const entering = (entry: (typeof view.entries)[number]) => !initial.current?.has(keyOf(entry))
  const model =
    chosenModel && chosenModel.model !== conversation.model ? chosenModel.model : conversation.model
  // The next message starts with the level of the last one, among the levels of its model.
  const lastMessage = pathTo(view.items, view.head).findLast((i) => i.kind === 'user_message')
  const lastLevel = lastMessage?.kind === 'user_message' ? (lastMessage.reasoning ?? null) : null
  const levels = levelsOf(models, model)
  const level = keptLevel(chosenLevel ? chosenLevel.level : lastLevel, levels)
  // A streaming response already counts as the response: `settled` is true during streaming.
  const running = !view.settled || view.items.some((i) => i.status === 'streaming')

  const run = async (action: () => Promise<unknown>) => {
    setFailure(null)
    try {
      await action()
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    }
  }

  const send = (text: string, parentId: string | null = view.head) =>
    run(async () => {
      const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1
      const sent = sendMessage({
        items: db.collection(items),
        account: me.id,
        conversationId,
        salt: conversation.id_salt,
        parentId,
        parts: [{ type: 'text', text }],
        reasoning: level,
        seq,
      })
      try {
        setPendingHead(await sent)
      } finally {
        setPendingHead(null)
      }
    })

  const chooseModel = (next: string | null) =>
    run(async () => {
      setChosenModel({ model: next })
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: next }),
      })
      if (!response.ok) {
        setChosenModel(null)
        throw new Error('The model could not be changed.')
      }
      refreshList()
    })

  const pick = (id: string) =>
    run(() => command(conversationId, { t: 'set_head', itemId: leafUnder(view.items, id) }))

  return (
    <section className="conversation">
      <TopBar>
        <h1>{conversation.title || 'Untitled'}</h1>
        {!online ? <Status kind="waiting">offline, sync waits</Status> : null}
        {running ? <Status kind="running" /> : null}
      </TopBar>
      <Poster className="chat-sheet">
        <MessageList>
          {view.entries.map((entry) => {
            if (entry.type === 'user') {
              return (
                <UserMessage
                  key={entry.item.id}
                  item={entry.item}
                  items={view.items}
                  onEdit={(text) => send(text, entry.item.parentId)}
                  onBranch={pick}
                  entering={entering(entry)}
                />
              )
            }
            if (entry.type === 'assistant') {
              const { status } = entry.item
              return (
                <Message
                  key={entry.item.id}
                  from="assistant"
                  streaming={entry.streaming}
                  end={status === 'interrupted' || status === 'failed' ? status : undefined}
                  details={details(entry.item.id)}
                  entering={entering(entry)}
                  actions={
                    entry.streaming ? undefined : (
                      <>
                        <Branches items={view.items} itemId={entry.item.id} onPick={pick} />
                        <Button
                          variant="quiet"
                          disabled={entry.item.parentId === null}
                          onClick={() => {
                            // Another response to what the response was answering: its sibling.
                            const answered = entry.item.parentId
                            if (answered)
                              void run(() =>
                                command(conversationId, { t: 'regenerate', itemId: answered }),
                              )
                          }}
                        >
                          Regenerate
                        </Button>
                      </>
                    )
                  }
                >
                  <Text text={entry.text} />
                </Message>
              )
            }
            if (entry.type === 'failure') {
              return (
                <Message
                  key={entry.item.id}
                  from="assistant"
                  end="failed"
                  entering={entering(entry)}
                >
                  <Text text={entry.message} />
                </Message>
              )
            }
            if (entry.type === 'say') {
              return (
                <Message key={entry.call.id} from="assistant" entering={entering(entry)}>
                  <Text text={entry.text} />
                </Message>
              )
            }
            if (entry.type === 'tool') {
              return (
                <ToolCall
                  key={entry.call.id}
                  name={entry.call.tool}
                  state={entry.state}
                  progress={entry.progress}
                >
                  <pre>{JSON.stringify(entry.call.input, null, 2)}</pre>
                  {entry.result ? <Parts parts={entry.result.output} /> : null}
                </ToolCall>
              )
            }
            return (
              <Question
                key={entry.call.id}
                call={entry.call}
                approval={entry.approval}
                answered={entry.result !== undefined}
                onAnswer={(value) =>
                  run(() =>
                    command(conversationId, { t: 'answer', callId: entry.call.callId, value }),
                  )
                }
              />
            )
          })}
        </MessageList>
        <p className="failure" role="alert">
          {failure ?? view.error}
        </p>
        <Composer
          onSend={(text) => send(text)}
          running={running}
          onStop={() => run(() => command(conversationId, { t: 'interrupt' }))}
          tools={
            <>
              <ModelPicker models={models} value={model} onChange={(m) => void chooseModel(m)} />
              <ReasoningPicker
                levels={levels}
                value={level}
                onChange={(l) => setChosenLevel({ level: l })}
              />
            </>
          }
        />
      </Poster>
    </section>
  )
}

function Text({ text }: { text: string }) {
  return (
    <>
      {text.split('\n\n').map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </>
  )
}

function Parts({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return null
  return (
    <div className="parts">
      {parts.map((p, i) =>
        p.type === 'text' ? (
          <pre key={i}>{p.text}</pre>
        ) : p.mediaType.startsWith('image/') && p.uri.startsWith('data:') ? (
          <img key={i} src={p.uri} alt="" width={320} height={240} />
        ) : (
          <a key={i} href={p.uri}>
            File {p.mediaType}
          </a>
        ),
      )}
    </div>
  )
}

function Branches(props: { items: Item[]; itemId: string; onPick: (id: string) => void }) {
  const { siblings, index } = branchesOf(props.items, props.itemId)
  return (
    <BranchSwitcher
      index={index}
      count={siblings.length}
      onPick={(i) => {
        const sibling = siblings[i]
        if (sibling) props.onPick(sibling.id)
      }}
    />
  )
}

function UserMessage(props: {
  item: Extract<Item, { kind: 'user_message' }>
  items: Item[]
  onEdit: (text: string) => Promise<void>
  onBranch: (id: string) => void
  entering: boolean
}) {
  const [editing, setEditing] = useState(false)
  const text = props.item.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
  if (editing) {
    return (
      <div className="editing">
        <Composer
          label="New version of the message"
          defaultValue={text}
          sendLabel="Send this version"
          onCancel={() => setEditing(false)}
          onSend={async (value) => {
            await props.onEdit(value)
            setEditing(false)
          }}
        />
      </div>
    )
  }
  return (
    <Message
      from="user"
      entering={props.entering}
      actions={
        <>
          <Branches items={props.items} itemId={props.item.id} onPick={props.onBranch} />
          <Button variant="quiet" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </>
      }
    >
      <Parts parts={props.item.parts.filter((p) => p.type === 'file')} />
      <Text text={text} />
    </Message>
  )
}
