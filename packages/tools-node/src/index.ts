// Outils de fichiers et de shell (specs/harness.md, Découpage en dossiers ; Architecture).
// Le gardien des accès fait respecter les dossiers racines indépendamment de `authorize`.

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { defineTool, type Tool, ToolInputError } from '@wica/runtime'

export type NodeToolsOptions = {
  /** Dossiers autorisés ; le premier sert de dossier de travail. */
  roots: string[]
  /** Délai maximal d'une commande shell, en millisecondes. */
  shellTimeoutMs?: number
}

export class AccessDeniedError extends Error {
  override name = 'AccessDeniedError'
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
}

/** Chemin réel du plus proche ancêtre existant : un lien symbolique ne fait pas sortir des racines. */
async function realExisting(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) throw new AccessDeniedError(`chemin introuvable : ${path}`)
    return resolve(await realExisting(parent), relative(parent, path))
  }
}

function stringArg(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string') throw new ToolInputError(`Argument « ${key} » attendu (texte).`)
  return value
}

export function nodeTools(options: NodeToolsOptions): Tool[] {
  if (options.roots.length === 0)
    throw new Error('nodeTools : au moins un dossier racine est requis')
  const roots = options.roots.map((r) => resolve(r))
  const cwd = roots[0] as string

  const guard = async (path: string): Promise<string> => {
    const absolute = resolve(cwd, path)
    const real = await realExisting(absolute)
    const realRoots = await Promise.all(roots.map((r) => realpath(r)))
    if (!realRoots.some((root) => isInside(real, root))) {
      throw new AccessDeniedError(`Accès refusé hors des dossiers autorisés : ${path}`)
    }
    return real
  }

  const pathSchema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'Chemin relatif au dossier de travail' } },
    required: ['path'],
  }

  return [
    defineTool({
      name: 'read_file',
      description: 'Lit un fichier texte.',
      input: pathSchema,
      annotations: { readOnlyHint: true },
      run: async (input) => readFile(await guard(stringArg(input, 'path')), 'utf8'),
    }),
    defineTool({
      name: 'list_dir',
      description: "Liste le contenu d'un dossier.",
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
      description: 'Écrit un fichier texte, en remplaçant son contenu.',
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
        return `Écrit : ${relative(cwd, target) || '.'} (${content.length} caractères)`
      },
    }),
    defineTool({
      name: 'bash',
      description: 'Exécute une commande shell dans le dossier de travail.',
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
            resolvePromise(`${out}\n[code de sortie : ${code ?? signal}]`),
          )
        }),
    }),
  ]
}
