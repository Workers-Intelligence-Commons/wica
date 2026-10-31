// Decoder of the "server-sent events" format (HTML Living Standard, section 9.2): a text stream
// split into messages by empty lines. Pure: chunks go in, messages come out.

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
    /** Adds a text chunk and returns the complete messages it finishes. */
    push(chunk: string): SseMessage[] {
      buffer += chunk
      const out: SseMessage[] = []
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer)
        if (!match) break
        // A \r at the end of a chunk can be followed by a \n in the next one: wait.
        if (match[0] === '\r' && match.index === buffer.length - 1) break
        line(buffer.slice(0, match.index), out)
        buffer = buffer.slice(match.index + match[0].length)
      }
      return out
    },
    /** End of the stream: a message without a final empty line is dropped, as the standard requires. */
    end(): SseMessage[] {
      buffer = ''
      data = []
      return []
    },
  }
}
