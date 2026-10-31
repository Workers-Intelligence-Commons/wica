// File and shell tools. The access guard enforces the root folders independently of `authorize`.

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { defineTool, type Tool, ToolInputError } from '@wica/runtime'

export type NodeToolsOptions = {
  /** Allowed folders; the first one serves as the working folder. */
  roots: string[]
  /** Maximum delay of a shell command, in milliseconds. */
  shellTimeoutMs?: number
}

export class AccessDeniedError extends Error {
  override name = 'AccessDeniedError'
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}

/** Real path of the closest existing ancestor: a symbolic link does not lead out of the roots. */
async function realExisting(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) throw new AccessDeniedError(`path not found: ${path}`)
    return resolve(await realExisting(parent), relative(parent, path))
  }
}

function stringArg(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string') throw new ToolInputError(`Argument "${key}" expected (text).`)
  return value
}

export function nodeTools(options: NodeToolsOptions): Tool[] {
  if (options.roots.length === 0) throw new Error('nodeTools: at least one root folder is required')
  const roots = options.roots.map((r) => resolve(r))
  const cwd = roots[0] as string

  const guard = async (path: string): Promise<string> => {
    const absolute = resolve(cwd, path)
    const real = await realExisting(absolute)
    const realRoots = await Promise.all(roots.map((r) => realpath(r)))
    if (!realRoots.some((root) => isInside(real, root))) {
      throw new AccessDeniedError(`Access denied outside the allowed folders: ${path}`)
    }
    return real
  }

  const pathSchema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the working folder' } },
    required: ['path'],
  }

  return [
    defineTool({
      name: 'read_file',
      description: 'Reads a text file.',
      input: pathSchema,
      annotations: { readOnlyHint: true },
      run: async (input) => readFile(await guard(stringArg(input, 'path')), 'utf8'),
    }),
    defineTool({
      name: 'list_dir',
      description: 'Lists the content of a folder.',
      input: pathSchema,
      annotations: { readOnlyHint: true },
      run: async (input) => {
        const entries = await readdir(await guard(stringArg(input, 'path')), {
          withFileTypes: true,
        })
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n')
      },
    }),
    defineTool({
      name: 'write_file',
      description: 'Writes a text file, replacing its content.',
      input: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      annotations: { destructiveHint: true, idempotentHint: true },
      run: async (input) => {
        const target = await guard(stringArg(input, 'path'))
        const content = stringArg(input, 'content')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
        return `Written: ${relative(cwd, target) || '.'} (${content.length} characters)`
      },
    }),
    defineTool({
      name: 'bash',
      description: 'Runs a shell command in the working folder.',
      input: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      annotations: { destructiveHint: true, openWorldHint: true },
      run: (input, ctx) =>
        new Promise((resolvePromise, reject) => {
          const child = spawn('/bin/sh', ['-c', stringArg(input, 'command')], {
            cwd,
            signal: ctx.signal,
            timeout: options.shellTimeoutMs ?? 120_000,
          })
          let out = ''
          child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
          child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
          child.on('error', reject)
          child.on('close', (code, signal) =>
            resolvePromise(`${out}\n[exit code: ${code ?? signal}]`),
          )
        }),
    }),
  ]
}
