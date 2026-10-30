// Faux service Open Responses pour les tests : les réponses d'un fournisseur sous forme de flux
// d'événements, comme `model-compat` les lit.

type Output = Record<string, unknown>

/** Un flux d'événements Open Responses pour une liste d'éléments de sortie. */
export function openResponsesStream(output: Output[]): Response {
  let n = 0
  const events: object[] = [{ type: 'response.created', sequence_number: n++, response: {} }]
  output.forEach((item, index) => {
    events.push({
      type: 'response.output_item.added',
      sequence_number: n++,
      output_index: index,
      item,
    })
    if (item.type === 'message') {
      const text = (item.content as { text: string }[])[0]?.text ?? ''
      // Deux deltas : un client doit recoller les morceaux d'un même texte.
      const half = Math.ceil(text.length / 2)
      for (const delta of [text.slice(0, half), text.slice(half)]) {
        events.push({
          type: 'response.output_text.delta',
          sequence_number: n++,
          item_id: item.id,
          output_index: index,
          content_index: 0,
          delta,
        })
      }
    }
    events.push({
      type: 'response.output_item.done',
      sequence_number: n++,
      output_index: index,
      item,
    })
  })
  events.push({ type: 'response.completed', sequence_number: n++, response: { output } })
  const raw = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')
  return new Response(raw, { headers: { 'content-type': 'text/event-stream' } })
}

export const openResponsesCall = (callId: string, name: string, args: unknown): Output => ({
  type: 'function_call',
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status: 'completed',
})

export const openResponsesMessage = (text: string): Output => ({
  type: 'message',
  id: 'msg',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

/**
 * Un flux de texte sans fin, un delta toutes les 5 ms, qui s'arrête quand la requête est annulée.
 */
export function endlessOpenResponsesStream(signal: AbortSignal | null | undefined): Response {
  let n = 0
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: object) =>
        controller.enqueue(
          encoder.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`),
        )
      send({ type: 'response.created', sequence_number: n++, response: {} })
      send({
        type: 'response.output_item.added',
        sequence_number: n++,
        output_index: 0,
        item: { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] },
      })
      timer = setInterval(() => {
        send({
          type: 'response.output_text.delta',
          sequence_number: n++,
          item_id: 'msg',
          output_index: 0,
          content_index: 0,
          delta: 'encore ',
        })
      }, 5)
      signal?.addEventListener('abort', () => {
        clearInterval(timer)
        controller.error(new DOMException('annulé', 'AbortError'))
      })
    },
    cancel() {
      clearInterval(timer)
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
