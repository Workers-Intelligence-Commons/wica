// Step 2 gate: all-local topology, a single process; an agent carries out a task on files from
// end to end, with approvals.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Client, createClient } from '@wica/client'
import { journalViolations } from '@wica/core'
import { allowAll, type Authorize, createHarness, type ModelAdapter } from '@wica/runtime'
import { nodeTools } from '@wica/tools-node'
import { memoryTransportPair } from '@wica/transport-memory'
import { describe, expect, it } from 'vite-plus/test'

import { scriptedModel } from '../src/index.ts'

const askForWrites: Authorize = (call) =>
  call.annotations.readOnlyHint ? 'allow' : { ask: `Allow ${call.tool}?` }

// The model reads notes.txt, writes it into todo.txt, then concludes; it adapts to a refusal.
const copyModel = () =>
  scriptedModel((request) => {
    const last = request.path.findLast((i) => i.kind !== 'event')
    const results = request.path.filter((i) => i.kind === 'tool_result')
    if (last?.kind === 'tool_result' && last.isError) {
      return { parts: [{ type: 'text', text: 'OK, I write nothing.' }] }
    }
    if (results.length === 0) {
      return {
        parts: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_call', callId: 'k1', tool: 'read_file', input: { path: 'notes.txt' } },
        ],
      }
    }
    if (results.length === 1) {
      const content =
        last?.kind === 'tool_result' && last.output[0]?.type === 'text' ? last.output[0].text : ''
      return {
        parts: [
          {
            type: 'tool_call',
            callId: 'k2',
            tool: 'write_file',
            input: { path: 'todo.txt', content },
          },
        ],
      }
    }
    return { parts: [{ type: 'text', text: 'Done.' }] }
  })

async function setup(model: ModelAdapter, authorize: Authorize) {
  const dir = await mkdtemp(join(tmpdir(), 'wica-step2-'))
  await writeFile(join(dir, 'notes.txt'), 'buy bread')
  const harness = createHarness({ model, tools: nodeTools({ roots: [dir] }), authorize })
  const { client: clientEnd, server } = memoryTransportPair()
  void harness.serve(server)
  const client = createClient(clientEnd, { from: { channel: 'local' } })
  await client.connect()
  await client.subscribe('c1')
  return { dir, harness, client }
}

function waitFor(client: Client, conversationId: string, ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 2000)
    const check = () => {
      if (!ready()) return
      clearTimeout(timer)
      off()
      resolve()
    }
    const off = client.onChange(conversationId, check)
    check()
  })
}

const finalText = (client: Client) =>
  client
    .view('c1')
    .entries.filter((e) => e.type === 'assistant' && !e.streaming)
    .map((e) => (e.type === 'assistant' ? e.text : ''))
    .at(-1)

describe('step 2', () => {
  it('carries out the task from end to end when the person grants the write', async () => {
    const { dir, harness, client } = await setup(copyModel(), askForWrites)
    await client.send('c1', 'Copy notes.txt into todo.txt')

    await waitFor(client, 'c1', () => client.view('c1').waiting.length > 0)
    const [question] = client.view('c1').waiting
    expect(question).toMatchObject({
      tool: 'approve',
      input: { question: 'Allow write_file?' },
    })
    await client.answer('c1', question!.callId, true)

    await waitFor(client, 'c1', () => finalText(client) === 'Done.')
    expect(await readFile(join(dir, 'todo.txt'), 'utf8')).toBe('buy bread')
    const view = client.view('c1')
    expect(view.entries.map((e) => e.type)).toEqual([
      'user',
      'tool',
      'tool',
      'question',
      'assistant',
    ])
    expect(
      view.entries.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.state),
    ).toEqual(['done', 'done'])
    const items = (await harness.store.load('c1', 0)).items
    expect(journalViolations(items)).toEqual([])
    await client.close()
  })

  it('writes nothing when the person refuses, and the model receives the refusal', async () => {
    const { dir, harness, client } = await setup(copyModel(), askForWrites)
    await client.send('c1', 'Copy notes.txt into todo.txt')
    await waitFor(client, 'c1', () => client.view('c1').waiting.length > 0)
    await client.answer('c1', client.view('c1').waiting[0]!.callId, false)

    await waitFor(client, 'c1', () => finalText(client) === 'OK, I write nothing.')
    await expect(readFile(join(dir, 'todo.txt'), 'utf8')).rejects.toThrow()
    const items = (await harness.store.load('c1', 0)).items
    expect(items.find((i) => i.kind === 'tool_result' && i.callId === 'k2')).toMatchObject({
      isError: true,
    })
    expect(journalViolations(items)).toEqual([])
    await client.close()
  })

  it('refuses a path outside the allowed folder, even when everything is allowed', async () => {
    const model = scriptedModel((request) =>
      request.path.some((i) => i.kind === 'tool_result')
        ? { parts: [{ type: 'text', text: 'End.' }] }
        : {
            parts: [
              {
                type: 'tool_call',
                callId: 'k1',
                tool: 'read_file',
                input: { path: '../../etc/passwd' },
              },
            ],
          },
    )
    const { harness, client } = await setup(model, allowAll)
    await client.send('c1', 'Read /etc/passwd')
    await waitFor(client, 'c1', () => finalText(client) === 'End.')
    const result = (await harness.store.load('c1', 0)).items.find((i) => i.kind === 'tool_result')
    expect(result).toMatchObject({ isError: true })
    expect(result?.kind === 'tool_result' && result.output[0]).toMatchObject({
      text: expect.stringContaining('Access denied'),
    })
    await client.close()
  })

  it('harness.run stays open during the question, then ends after the answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wica-step2-'))
    await writeFile(join(dir, 'notes.txt'), 'buy bread')
    const harness = createHarness({
      model: copyModel(),
      tools: nodeTools({ roots: [dir] }),
      authorize: askForWrites,
    })
    const seen: string[] = []
    for await (const event of harness.run('Copy notes.txt into todo.txt', {
      conversationId: 'r1',
    })) {
      seen.push(event.type)
      if (event.type === 'question') await harness.answer('r1', event.question.callId, true)
    }
    expect(seen).toContain('question')
    expect(seen.at(-1)).toBe('done')
    expect(await readFile(join(dir, 'todo.txt'), 'utf8')).toBe('buy bread')
  })
})
