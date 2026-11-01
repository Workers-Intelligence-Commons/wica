// Changes to the list of conversations, through the API. On Workers the list is read again
// afterwards; on Compose the sync brings the change.

import { apiFetch } from './guest.ts'
import { refreshList } from './sync/index.ts'

/** What deleting did: put in the trash, handed over to the commons, or erased from the trash. */
export type DeleteOutcome = 'trashed' | 'given' | 'erased'

async function call(path: string, init: RequestInit) {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `request refused (${response.status})`)
  }
  refreshList()
  return response
}

const at = (id: string) => `/api/conversations/${encodeURIComponent(id)}`

export const renameConversation = (id: string, title: string) =>
  call(at(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })

export async function deleteConversation(id: string, forever = false): Promise<DeleteOutcome> {
  const response = await call(`${at(id)}${forever ? '?forever=1' : ''}`, { method: 'DELETE' })
  return ((await response.json()) as { outcome: DeleteOutcome }).outcome
}

export const restoreConversation = (id: string) => call(`${at(id)}/restore`, { method: 'POST' })
