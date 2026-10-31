// Model adapter for an Open Responses service, wic-serving first. The conversion comes from
// `codecs`; this package does only the networking: request, retries before the stream, reading
// the stream, cancellation.

import {
  createOpenResponsesDecoder,
  createSseDecoder,
  type RequestOptions,
  toOpenResponsesRequest,
} from '@wica/codecs'
import type { ModelRequest } from '@wica/core'
import type { ModelAdapter, ModelChunk } from '@wica/runtime'

export type OpenResponsesModelOptions = {
  /** Base address of the API, for example `http://localhost:8000/v1`. */
  baseUrl: string
  model: string
  /** Name written into the opaque reasoning data; `wic-serving` by default. */
  provider?: string
  /** Key sent in `Authorization: Bearer`, read at each request. */
  apiKey?: string | (() => Promise<string>)
  headers?: Record<string, string>
  reasoning?: RequestOptions['reasoning']
  maxOutputTokens?: number
  temperature?: number
  /** Retries of a request that fails before the stream starts; 3 by default. */
  retries?: number
  fetch?: typeof fetch
}

/** Failure of the model service, after retries. */
export class ModelError extends Error {
  override name = 'ModelError'
  readonly status: number | undefined
  readonly code: string | null | undefined
  constructor(message: string, status?: number, code?: string | null) {
    super(message)
    this.status = status
    this.code = code
  }
}

class Retryable {
  readonly _tag = 'Retryable'
  readonly error: ModelError
  constructor(error: ModelError) {
    this.error = error
  }
}

/** Transient HTTP statuses: the same request may succeed later. */
export const isRetryableStatus = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500

async function errorMessage(response: Response): Promise<{ message: string; code?: string }> {
  const body = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } }
    if (parsed.error?.message) {
      return {
        message: parsed.error.message,
        ...(parsed.error.code ? { code: parsed.error.code } : {}),
      }
    }
  } catch {
    // A body that is not JSON: keep the text.
  }
  return { message: body || response.statusText || `HTTP ${response.status}` }
}

export function openResponsesModel(options: OpenResponsesModelOptions): ModelAdapter {
  const provider = options.provider ?? 'wic-serving'
  const doFetch = options.fetch ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/responses`

  /** Wait before a new attempt, interrupted by cancellation. */
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
    })

  /** One attempt: the response stream, or an error marked transient or permanent. */
  const attempt = async (body: string, signal: AbortSignal) => {
    const key = typeof options.apiKey === 'function' ? await options.apiKey() : options.apiKey
    let response: Response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...options.headers,
        },
        body,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw new ModelError('Model request cancelled.')
      throw new Retryable(new ModelError(`Model service unreachable: ${String(error)}`))
    }
    if (response.ok && response.body) return response.body
    const { message, code } = await errorMessage(response)
    const error = new ModelError(message, response.status, code ?? null)
    throw isRetryableStatus(response.status) ? new Retryable(error) : error
  }

  /** Retries transient failures with a doubling wait, as long as the stream has not started. */
  const connect = async (request: ModelRequest, signal: AbortSignal) => {
    const body = JSON.stringify(
      toOpenResponsesRequest(request, {
        model: options.model,
        provider,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    )
    const retries = options.retries ?? 3
    for (let n = 0; ; n++) {
      try {
        return await attempt(body, signal)
      } catch (error) {
        if (!(error instanceof Retryable)) throw error
        if (n >= retries || signal.aborted) throw error.error
        await wait(500 * 2 ** n, signal)
      }
    }
  }

  return {
    async *stream(request, signal): AsyncIterable<ModelChunk> {
      const body = await connect(request, signal)
      const reader = body.pipeThrough(new TextDecoderStream()).getReader()
      const sse = createSseDecoder()
      const decoder = createOpenResponsesDecoder({ provider })
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          for (const message of sse.push(value)) {
            if (message.data === '[DONE]') continue
            for (const chunk of decoder.push(JSON.parse(message.data))) {
              if (chunk.type === 'failed')
                throw new ModelError(chunk.message, undefined, chunk.code)
              if (chunk.type === 'done') yield { type: 'done', message: chunk.message }
              else yield chunk
            }
          }
          if (decoder.finished) break
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      if (!decoder.finished)
        throw new ModelError('The model stream stopped without a final response.')
    },
  }
}
