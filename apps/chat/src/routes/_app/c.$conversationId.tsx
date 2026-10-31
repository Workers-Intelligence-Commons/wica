// Une conversation : le chemin affiché de son arbre, en direct. Les éléments et leurs lots
// viennent des collections synchronisées ; les commandes partent par l'API. Le défilement colle
// en bas pendant le flux seulement si la personne y était déjà.

import { eq, useDbClient, useLiveQuery, useLiveSuspenseQuery } from '@tanstack/react-db'
import { createFileRoute, notFound } from '@tanstack/react-router'
import type { Item, Part } from '@wica/core'
import {
  BranchSwitcher,
  Button,
  Composer,
  Message,
  MessageList,
  Skeleton,
  Status,
  ToolCall,
} from '@workers-intelligence-commons/components'
import { Suspense, useEffect, useState } from 'react'

import { cacheName, touchConversation } from '../../client/cache.ts'
import {
  chunksCollection,
  conversationsCollection,
  itemsCollection,
  serversCollection,
} from '../../client/collections.ts'
import { command, sendMessage } from '../../client/commands.ts'
import { prepareCache } from '../../client/dependencies.ts'
import { branchesOf, conversationView, leafUnder } from '../../client/view.ts'
import { Question } from '../../ui/Question.tsx'

/** Sans battement de cœur depuis ce délai, un serveur distant est dit hors ligne. */
const OFFLINE_AFTER_MS = 45_000

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
      <div className="wic-messages">
        <Skeleton lines={8} label="Loading messages" />
      </div>
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

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

function Conversation({ conversationId }: { conversationId: string }) {
  const { me } = Route.useRouteContext()
  const db = useDbClient()
  const items = itemsCollection(conversationId)
  const chunks = chunksCollection(conversationId)
  const { data: conversations } = useLiveSuspenseQuery({
    query: (q) => q.from({ c: conversationsCollection }).where(({ c }) => eq(c.id, conversationId)),
  })
  const conversation = conversations[0]
  const { data: rows } = useLiveSuspenseQuery({ query: (q) => q.from({ i: items }) })
  const { data: chunkRows } = useLiveQuery({ query: (q) => q.from({ k: chunks }) })
  const { data: servers } = useLiveQuery({ query: (q) => q.from({ s: serversCollection }) })
  const online = useOnline()
  const now = useNow(10_000)
  const [pendingHead, setPendingHead] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  if (!conversation) throw notFound()
  const knownPending = pendingHead && rows.some((r) => r.id === pendingHead) ? pendingHead : null
  const head = knownPending ?? conversation.head_item_id
  const view = conversationView(rows, chunkRows, head)
  const server = conversation.server_id
    ? servers.find((s) => s.id === conversation.server_id)
    : undefined
  const offline =
    conversation.server_id !== null &&
    (!server?.last_seen_at || now - Date.parse(server.last_seen_at) > OFFLINE_AFTER_MS)
  // Une réponse en flux compte déjà comme la réponse : `settled` est vrai pendant le flux.
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
        seq,
      })
      try {
        setPendingHead(await sent)
      } finally {
        setPendingHead(null)
      }
    })

  const pick = (id: string) =>
    run(() => command(conversationId, { t: 'set_head', itemId: leafUnder(view.items, id) }))

  return (
    <section className="conversation">
      <header className="conversation-head">
        <h1>{conversation.title || 'Untitled'}</h1>
        {offline ? <Status kind="offline">server offline, your messages wait</Status> : null}
        {!online ? <Status kind="waiting">offline, sync waits</Status> : null}
        {running ? <Status kind="running" /> : null}
      </header>
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
                actions={
                  entry.streaming ? undefined : (
                    <>
                      <Branches items={view.items} itemId={entry.item.id} onPick={pick} />
                      <Button
                        variant="quiet"
                        disabled={entry.item.parentId === null}
                        onClick={() => {
                          // Une autre réponse à ce à quoi la réponse répondait : sa sœur.
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
          if (entry.type === 'say') {
            return (
              <Message key={entry.call.id} from="assistant">
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
      />
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
