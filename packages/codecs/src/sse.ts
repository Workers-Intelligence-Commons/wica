// Décodeur du format « server-sent events » (HTML Living Standard, section 9.2) : un flux de
// texte découpé en messages par des lignes vides. Pur : les morceaux entrent, les messages sortent.

export type SseMessage = { event?: string; data: string; id?: string }

export function createSseDecoder() {
  let buffer = ''
  let data: string[] = []
  let event: string | undefined
  let id: string | undefined

  const line = (raw: string, out: SseMessage[]) => {
    if (raw === '') {
      if (data.length > 0) {
        out.push({
          data: data.join('\n'),
          ...(event !== undefined ? { event } : {}),
          ...(id !== undefined ? { id } : {}),
        })
      }
      data = []
      event = undefined
      return
    }
    if (raw.startsWith(':')) return
    const colon = raw.indexOf(':')
    const field = colon < 0 ? raw : raw.slice(0, colon)
    let value = colon < 0 ? '' : raw.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
  }

  return {
    /** Ajoute un morceau de texte et rend les messages complets qu'il termine. */
    push(chunk: string): SseMessage[] {
      buffer += chunk
      const out: SseMessage[] = []
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer)
        if (!match) break
        // Un \r en fin de morceau peut être suivi d'un \n dans le suivant : on attend.
        if (match[0] === '\r' && match.index === buffer.length - 1) break
        line(buffer.slice(0, match.index), out)
        buffer = buffer.slice(match.index + match[0].length)
      }
      return out
    },
    /** Fin du flux : un message sans ligne vide finale est abandonné, comme le veut la norme. */
    end(): SseMessage[] {
      buffer = ''
      data = []
      return []
    },
  }
}
