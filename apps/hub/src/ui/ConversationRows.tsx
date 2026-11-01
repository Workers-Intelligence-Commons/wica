// Rows of conversations with their actions: rename in place, and delete. Deleting puts a
// conversation in the trash, with an undo; a conversation given to the commons is handed over to
// the commons instead, after a confirmation, since it does not come back.

import { Link, useNavigate } from '@tanstack/react-router'
import { Button, Dialog } from '@workers-intelligence-commons/components'
import { type FormEvent, useState } from 'react'

import {
  deleteConversation,
  renameConversation,
  restoreConversation,
} from '../client/conversations.ts'
import type { ConversationRow } from '../shared/rows.ts'

/** Every word of the search appears in the title, in any case. */
export function matchesTitle(title: string, search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const text = (title || 'Untitled').toLowerCase()
  return words.every((w) => text.includes(w))
}

export function ConversationRows(props: { rows: ConversationRow[]; current?: string | undefined }) {
  const navigate = useNavigate()
  const [trashed, setTrashed] = useState<ConversationRow | null>(null)
  const [giving, setGiving] = useState<ConversationRow | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  async function remove(row: ConversationRow) {
    setFailed(null)
    try {
      const outcome = await deleteConversation(row.id)
      setGiving(null)
      if (outcome === 'trashed') setTrashed(row)
      if (props.current === row.id) await navigate({ to: '/' })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      {props.rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          current={props.current === row.id}
          onDelete={() => (row.contributed_at ? setGiving(row) : void remove(row))}
        />
      ))}
      {trashed ? (
        <li className="conv-undo" role="status">
          <span>“{trashed.title || 'Untitled'}” is in the trash.</span>
          <Button
            variant="quiet"
            onClick={() => {
              void restoreConversation(trashed.id)
              setTrashed(null)
            }}
          >
            Undo
          </Button>
        </li>
      ) : null}
      {failed ? (
        <li className="failure" role="alert">
          {failed}
        </li>
      ) : null}
      <Dialog title="Leave to the commons" open={giving !== null} onClose={() => setGiving(null)}>
        <p>
          “{giving?.title || 'Untitled'}” was given to the commons under CC0. Deleting it removes it
          from your conversations, but it stays in the commons: the dedication cannot be withdrawn.
        </p>
        <div className="dialog-actions">
          <Button variant="primary" onClick={() => giving && void remove(giving)}>
            Remove from my conversations
          </Button>
          <Button variant="quiet" onClick={() => setGiving(null)}>
            Keep it
          </Button>
        </div>
      </Dialog>
    </>
  )
}

function Row(props: { row: ConversationRow; current: boolean; onDelete: () => void }) {
  const { row } = props
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(row.title)
  const [failed, setFailed] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await renameConversation(row.id, title)
      setEditing(false)
      setOpen(false)
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    }
  }

  if (editing) {
    return (
      <li className="wic-conversation conv-row">
        <form className="conv-rename" onSubmit={(e) => void save(e)}>
          <input
            className="wic-input wic-focus"
            aria-label="Title"
            value={title}
            maxLength={200}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          />
          <Button type="submit" variant="primary">
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
      </li>
    )
  }

  return (
    <li className={`wic-conversation conv-row${props.current ? ' wic-conversation-current' : ''}`}>
      <Link
        to="/c/$conversationId"
        params={{ conversationId: row.id }}
        className="wic-conversation-link wic-focus"
        aria-current={props.current ? 'page' : undefined}
      >
        <span className="wic-conversation-title">{row.title || 'Untitled'}</span>
      </Link>
      <button
        type="button"
        className="conv-more wic-focus"
        aria-label={`Actions for ${row.title || 'Untitled'}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">···</span>
      </button>
      {open ? (
        <div className="conv-actions">
          <Button
            variant="quiet"
            onClick={() => {
              setTitle(row.title)
              setEditing(true)
            }}
          >
            Rename
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              setOpen(false)
              props.onDelete()
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </li>
  )
}
