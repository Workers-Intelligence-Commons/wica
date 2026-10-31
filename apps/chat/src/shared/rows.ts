// Correspondance entre un élément du journal et sa ligne dans `items`, commune au serveur et au
// navigateur. `payload` porte l'élément ; `seq`, `status` et `parent_id` ont leurs colonnes, qui
// font foi.

import { canonicalJson, type Item, type ItemDraft, type Part, sha256 } from '@wica/core'

export type ItemRow = {
  conversation_id: string
  id: string
  parent_id: string | null
  seq: number
  kind: string
  payload: Record<string, unknown>
  status: Item['status']
  blob_sha256: string | null
}

export type ChunkRow = { conversation_id: string; item_id: string; idx: number; text: string }

export const rowToItem = (row: Pick<ItemRow, 'id' | 'parent_id' | 'seq' | 'status' | 'payload'>) =>
  ({
    ...row.payload,
    id: row.id,
    parentId: row.parent_id,
    seq: row.seq,
    status: row.status,
  }) as Item

/**
 * Au-delà de ce poids, un résultat d'outil part dans `blobs` : la synchro ne transporte que son
 * aperçu, et le modèle relit le contenu complet par le `Store`.
 */
export const BLOB_THRESHOLD = 64 * 1024
const PREVIEW_CHARS = 2_000

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Ligne à écrire pour un élément, et le contenu complet à mettre de côté s'il est trop gros. */
export function draftToRow(draft: ItemDraft): {
  payload: Record<string, unknown>
  blob: { sha256: string; output: Part[] } | null
} {
  const { seq: _seq, ...payload } = draft as ItemDraft & { seq?: number }
  if (draft.kind !== 'tool_result') return { payload, blob: null }
  const json = canonicalJson(draft.output)
  if (json.length <= BLOB_THRESHOLD) return { payload, blob: null }
  const digest = hex(sha256(new TextEncoder().encode(json)))
  const text = draft.output.map((p) => (p.type === 'text' ? p.text : `[${p.mediaType}]`)).join('\n')
  const preview: Part[] = [
    {
      type: 'text',
      text: `${text.slice(0, PREVIEW_CHARS)}\n[aperçu : ${json.length} octets au total]`,
    },
  ]
  return {
    payload: { ...payload, output: preview },
    blob: { sha256: digest, output: draft.output },
  }
}

/** Élément complet : un aperçu reprend le contenu mis de côté. */
export const restoreItem = (item: Item, blob: Part[] | undefined): Item =>
  blob && item.kind === 'tool_result' ? { ...item, output: blob } : item
