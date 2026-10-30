// Client en ligne de commande : affiche la conversation au fil du flux, pose les questions et
// les approbations au clavier, et envoie les messages tapés. Ctrl-C interrompt un tour en cours,
// ou quitte quand rien ne tourne.

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import type { Client } from '@wica/client'
import { ELICIT_TOOL, type Item } from '@wica/core'
import type { AskUserAnswer, AskUserInput, ElicitAnswer } from '@wica/tools-user'

import {
  elicitFields,
  parseAnswer,
  parseElicitField,
  parseField,
  parseYesNo,
  prompt,
} from './answers.ts'

type Call = Extract<Item, { kind: 'tool_call' }>

const short = (value: unknown) => {
  const text = JSON.stringify(value)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

export function runCli(
  client: Client,
  conversationId: string,
  io: { input: Readable; output: Writable },
): Promise<void> {
  const rl = createInterface({ input: io.input, output: io.output, prompt: '> ' })
  // L'invite n'est réaffichée qu'après une sortie ou une saisie, pas à chaque changement.
  let prompted = false
  const write = (text: string) => {
    prompted = false
    io.output.write(text)
  }
  const printed = new Map<string, number>()
  const shown = new Set<string>()
  const answered = new Set<string>()
  let lineWaiter: ((line: string) => void) | null = null
  let asking = false
  let busy = false
  // Un envoi reste en cours jusqu'à ce que le serveur ait annoncé un tour, puis sa fin.
  let sawRunning = false
  let streamingOpen = false

  const nextLine = () => new Promise<string>((resolve) => (lineWaiter = resolve))

  async function askUntil<T>(text: string, parse: (line: string) => { ok: T } | { error: string }) {
    write(`${text}\n`)
    for (;;) {
      rl.setPrompt('? ')
      rl.prompt()
      const result = parse(await nextLine())
      if ('ok' in result) return result.ok
      write(`${result.error}\n`)
    }
  }

  async function ask(call: Call) {
    if (call.tool === 'approve') {
      const input = call.input as { question: string }
      const yes = await askUntil(`${input.question} [o/n]`, parseYesNo)
      return client.answer(conversationId, call.callId, yes)
    }
    if (call.tool === ELICIT_TOOL) {
      // Demande d'un serveur MCP : la personne peut refuser d'y répondre.
      const input = call.input as {
        server: string
        message: string
        mode?: 'form' | 'url'
        url?: string
        requestedSchema?: unknown
      }
      const where = input.mode === 'url' ? `\nAdresse : ${input.url ?? ''}` : ''
      const agree = await askUntil(
        `[${input.server}] ${input.message}${where}\nRépondre ? [o/n]`,
        parseYesNo,
      )
      if (!agree) {
        const answer: ElicitAnswer = { action: 'decline' }
        return client.answer(conversationId, call.callId, answer)
      }
      const content: NonNullable<ElicitAnswer['content']> = {}
      for (const field of input.mode === 'url' ? [] : elicitFields(input.requestedSchema)) {
        const value = await askUntil(`${field.label} :`, (line) => parseElicitField(field, line))
        if (value !== null) content[field.name] = value
      }
      const answer: ElicitAnswer = { action: 'accept', content }
      return client.answer(conversationId, call.callId, answer)
    }
    const input = call.input as AskUserInput
    if (input.kind !== 'form') {
      const answer = await askUntil(prompt(input), (line) => parseAnswer(input, line))
      return client.answer(conversationId, call.callId, answer)
    }
    write(`${input.question}\n`)
    const values: Record<string, string | number | boolean> = {}
    for (const field of input.fields) {
      const value = await askUntil(`${field.label} :`, (line) => parseField(field, line))
      if (value !== null) values[field.name] = value
    }
    const answer: AskUserAnswer = { kind: 'form', values }
    return client.answer(conversationId, call.callId, answer)
  }

  const render = () => {
    const view = client.view(conversationId)
    for (const entry of view.entries) {
      if (entry.type === 'assistant') {
        const done = printed.get(entry.item.id) ?? 0
        if (entry.text.length > done) {
          write(entry.text.slice(done))
          printed.set(entry.item.id, entry.text.length)
          streamingOpen = true
        }
        if (!entry.streaming && streamingOpen && !shown.has(entry.item.id)) {
          shown.add(entry.item.id)
          write('\n')
          streamingOpen = false
        }
      } else if (entry.type === 'say' && !shown.has(entry.call.id)) {
        shown.add(entry.call.id)
        write(`${entry.text}\n`)
      } else if (entry.type === 'tool') {
        if (!shown.has(entry.call.id)) {
          shown.add(entry.call.id)
          write(`[${entry.call.tool}] ${short(entry.call.input)}\n`)
        }
        if (entry.result && !shown.has(entry.result.id)) {
          shown.add(entry.result.id)
          if (entry.result.isError) {
            const first = entry.result.output[0]
            write(`[${entry.call.tool}] erreur : ${first?.type === 'text' ? first.text : ''}\n`)
          }
        }
      }
    }
    if (view.error && !shown.has(`error:${view.error}`)) {
      shown.add(`error:${view.error}`)
      write(`Erreur : ${view.error}\n`)
    }
    const question = view.waiting.find((c) => !answered.has(c.callId))
    if (question && !asking) {
      asking = true
      answered.add(question.callId)
      void ask(question).finally(() => {
        asking = false
        render()
      })
      return
    }
    if (view.running) sawRunning = true
    if (busy && sawRunning && !view.running && view.waiting.length === 0) {
      busy = false
      sawRunning = false
    }
    if (!busy && !asking && !prompted) {
      prompted = true
      rl.setPrompt('> ')
      rl.prompt()
    }
  }

  return new Promise((resolve) => {
    const off = client.onChange(conversationId, render)
    rl.on('line', (line) => {
      prompted = false
      if (lineWaiter) {
        const waiter = lineWaiter
        lineWaiter = null
        return waiter(line)
      }
      if (busy) return write('(un tour tourne ; Ctrl-C pour l’interrompre)\n')
      const text = line.trim()
      if (text === '') return rl.prompt()
      if (text === '/quit') return rl.close()
      busy = true
      void client.send(conversationId, text).catch((e: unknown) => {
        write(`Envoi impossible : ${String(e)}\n`)
        busy = false
        rl.prompt()
      })
    })
    rl.on('SIGINT', () => {
      if (busy || client.view(conversationId).running) {
        write('\n(interruption)\n')
        void client.interrupt(conversationId)
      } else rl.close()
    })
    rl.on('close', () => {
      off()
      resolve()
    })
    render()
  })
}
