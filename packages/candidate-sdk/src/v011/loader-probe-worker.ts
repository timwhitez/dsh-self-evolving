#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { pathToFileURL } from 'node:url'

const [entry, candidateId, mode] = process.argv.slice(2)
if (
  entry === undefined ||
  candidateId === undefined ||
  (mode !== 'solve' && mode !== 'propose') ||
  !entry.startsWith('/runtime/node_modules/@dsh-rsi/')
) {
  throw new Error('v0.1.1 Loader probe: invalid trusted arguments')
}

interface LoaderEntry {
  options: { id: string; name: string }
}

interface LoaderContext {
  loader: {
    internal?: { version: string; import: (specifier: string) => Promise<unknown> }
    create: (options: { id: string; name: string; config: unknown }) => Promise<string>
    await: () => Promise<void>
    entries: () => Iterable<LoaderEntry>
  }
  systemPrompt: { assemble: () => Promise<{ sections: Array<{ name: string; text: string }> }> }
}

function handles(): string[] {
  return (
    (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
  )
    .map(
      (handle) => (handle as { constructor?: { name?: string } }).constructor?.name ?? 'anonymous',
    )
    .sort()
}

function effects(ctx: Context): string[] {
  const output: string[] = []
  const visit = (
    rows: Array<{ label: string; children: Array<{ label: string; children: never[] }> }>,
    prefix: string,
  ) => {
    for (const row of rows) {
      const path = prefix.length === 0 ? row.label : `${prefix}/${row.label}`
      output.push(path)
      visit(row.children, path)
    }
  }
  visit(ctx.fiber.getEffects() as never, '')
  return output.sort()
}

const before = handles()
const ctx = new Context()
let receipt: Record<string, unknown>
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Loader)
  const runtime = ctx as unknown as LoaderContext
  runtime.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@dsh-rsi/admission-candidate') {
        throw new Error(`v0.1.1 Loader probe: unexpected import ${specifier}`)
      }
      return import(pathToFileURL(entry).href)
    },
  }
  await runtime.loader.create({
    id: 'rsi-admission-candidate',
    name: '@dsh-rsi/admission-candidate',
    config: { candidateId, mode },
  })
  await runtime.loader.await()
  const entries = [...runtime.loader.entries()]
    .map((row) => `${row.options.id}:${row.options.name}`)
    .sort()
  if (!entries.some((row) => row.startsWith('rsi-admission-candidate:'))) {
    throw new Error('v0.1.1 Loader probe: candidate row did not activate')
  }
  const assembly = await runtime.systemPrompt.assemble()
  const rendered = assembly.sections.map((section) => `${section.name}\n${section.text}`).join('\n')
  receipt = {
    schemaVersion: 1,
    mode,
    candidateId,
    entries,
    componentInventory: effects(ctx),
    promptSections: assembly.sections.map((section) => section.name).sort(),
    replayDigest: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
  }
} finally {
  await ctx.fiber.dispose()
}
const after = handles()
const leakedHandles = after.filter((handle) => !before.includes(handle))
if (leakedHandles.length > 0) {
  throw new Error(`v0.1.1 Loader probe: leaked handles ${leakedHandles.join(',')}`)
}
process.stdout.write(
  `DSH_RSI_V011_LOADER_RECEIPT=${JSON.stringify({ ...receipt!, leakedHandles })}\n`,
)
