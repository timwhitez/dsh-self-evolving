/**
 * Gate 0 — real Cordis Loader E2E (spec 07 §2 Accept).
 *
 * This test does NOT use a hand-rolled `ctx.plugin()`. It boots a real
 * `@deepseek-ai/cordis-plugin-loader`, registers Include/Group as loader
 * builtins exactly as `@deepseek-ai/dsh-app-boot` does in production, and
 * mounts a `cordis.yml` fixture via a `cordis:include` entry. The candidate
 * bundle therefore traverses the same default-unwrap, inject-resolution and
 * Fiber lifecycle path as a real deployment. It is model-free: no LLM, no
 * agent, no network — only the prompt surface and the loader.
 *
 * Acceptance mapped to spec 07 §2:
 *  - "baseline namespace plugin 通过真实 Loader" → boot succeeds; the candidate
 *    row is an active loader entry and systemPrompt is live on the context;
 *  - "unload 后 inventory 与 boot 前精确一致" → after disposing the whole tree
 *    no loader entries remain and no forbidden handles (socket/child/server) leak.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { render, snapshot } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, '..', 'fixtures')
// Upstream DSH checkout root, for linking built packages into the fixture.
const dshRoot = resolve(here, '..', '..', '..', 'deepseek-harness')
const repoRoot = resolve(here, '..', '..', '..')

let root: string | undefined
let ctx: Context | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-gate0-'))
})

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } catch {
    // disposal errors must not mask the test result; the snapshot assertion is
    // the real gate. We still attempt cleanup.
  }
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Link a real built package into the fixture's node_modules under its scope.
 * The loader resolves candidate/DSH specifiers from this fixture root, exactly
 * as a production install would.
 */
async function linkPackage(scope: string, name: string, source: string): Promise<void> {
  const fixtureRoot = root as string
  const scopeDir = join(fixtureRoot, 'node_modules', scope)
  await mkdir(scopeDir, { recursive: true })
  await symlink(source, join(scopeDir, name), process.platform === 'win32' ? 'junction' : 'dir')
}

interface LoaderEntry {
  options: { id: string; name: string }
}
interface LoaderCtx {
  loader: {
    internal?: { version: string; import: (s: string) => Promise<unknown> }
    builtins: { include: unknown; group: unknown }
    create: (opts: { id: string; name: string; config: unknown }) => Promise<string>
    await: () => Promise<void>
    entries: () => Iterable<LoaderEntry>
    resolve: (id: string) => LoaderEntry
  }
  get: <T = unknown>(name: string) => T | undefined
}

async function bootFixture(): Promise<Context> {
  const fixtureRoot = root as string
  await mkdir(join(fixtureRoot, 'node_modules'), { recursive: true })

  // Link built packages: the candidate bundle + every DSH package the loader
  // will resolve from the cordis.yml rows.
  await linkPackage(
    '@dsh-rsi',
    'candidate-baseline',
    resolve(repoRoot, 'packages', 'candidate-baseline'),
  )
  await linkPackage('@deepseek-ai', 'cordis', join(dshRoot, 'vendor', 'cordis'))
  await linkPackage('@deepseek-ai', 'schemastery', join(dshRoot, 'vendor', 'schemastery'))
  await linkPackage('@deepseek-ai', 'cosmokit', join(dshRoot, 'vendor', 'cosmokit'))
  await linkPackage(
    '@deepseek-ai',
    'dsh-system-prompt',
    join(dshRoot, 'packages', 'core', 'system-prompt'),
  )
  await linkPackage('@deepseek-ai', 'cordis-plugin-loader', join(dshRoot, 'vendor', 'loader'))
  await linkPackage('@deepseek-ai', 'cordis-plugin-include', join(dshRoot, 'vendor', 'include'))
  await linkPackage('@deepseek-ai', 'cordis-plugin-group', join(dshRoot, 'vendor', 'group'))

  // Copy the real cordis.yml fixture in.
  const cordisYml = await readFile(resolve(fixturesDir, 'cordis.yml'), 'utf8')
  await writeFile(join(fixtureRoot, 'cordis.yml'), cordisYml)

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(fixtureRoot, 'cordis.yml')).href

  // Mount the real Loader service.
  await ctx.plugin(Loader)

  const c = ctx as unknown as Context & LoaderCtx

  // Override the loader's module importer to resolve specifiers from the
  // fixture root (whose node_modules links the real built packages). This is
  // the canonical real-loader test seam; it does not bypass the Loader — it
  // only controls WHERE module specifiers resolve, same as production node_modules.
  const fixtureRequire = createRequire(join(fixtureRoot, 'package.json'))
  c.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const resolved = fixtureRequire.resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    },
  }

  // Register Include and Group as loader builtins, exactly as dsh-app-boot's
  // mountRootInclude() does in production. The root entry below uses the
  // `cordis:include` builtin name to consume this.
  c.loader.builtins.include = Include
  c.loader.builtins.group = Group

  // Create the root include entry that reads cordis.yml. This mirrors
  // mountRootInclude()'s { id:'include', name:'cordis:include', config:{path} }.
  await c.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: pathToFileURL(join(fixtureRoot, 'cordis.yml')).href },
  })
  await c.loader.await()
  return ctx
}

const BOOT_TIMEOUT = { timeout: 60_000 }

describe('Gate 0 — real Cordis Loader lifecycle', () => {
  it(
    'boots the baseline candidate through the real Loader and exposes systemPrompt',
    BOOT_TIMEOUT,
    async () => {
      const c = await bootFixture()
      const lc = c as unknown as Context & LoaderCtx

      const entries = [...lc.loader.entries()].map((e) => `${e.options.id}:${e.options.name}`)
      expect(entries).toContain('rsi-candidate:@dsh-rsi/candidate-baseline')
      expect(entries).toContain('system-prompt:@deepseek-ai/dsh-system-prompt')
      // systemPrompt service is live on the context (the candidate injected it).
      expect(lc.get('systemPrompt')).toBeDefined()
      // The candidate's prompt section was registered: render the assembled
      // prompt and confirm the baseline's marker text is present. This proves the
      // candidate's apply() ran through the real Loader, not just that a row exists.
      const assembly = await (
        c as unknown as {
          systemPrompt: {
            assemble: (opts?: unknown) => Promise<{ sections: { name: string; text: string }[] }>
          }
        }
      ).systemPrompt.assemble()
      const rendered = renderPrompt(assembly)
      expect(rendered).toContain('Terminal-Bench')
    },
  )

  it(
    'unloads the whole tree with no leaked loader entry or handle beyond baseline',
    BOOT_TIMEOUT,
    async () => {
      // Capture the ambient handle baseline BEFORE any Cordis boot: the test
      // runner itself keeps sockets (vitest IPC). The quiescence gate is a DELTA:
      // whatever handles exist when nothing RSI-owned is loaded must be exactly
      // what exists again after a full boot+unload. A candidate that leaked a
      // timer/socket/child process would add a handle that never returns.
      const baselineHandles = activeHandleNames()

      const c = await bootFixture()
      const lc = c as unknown as Context & LoaderCtx

      // Auditable loaded snapshot (proves the candidate row mounted).
      const loaded = snapshot(c, 'loaded')
      expect(render(loaded)).toMatch(/rsi-candidate/)

      // Confirm at least the candidate and service rows are active before dispose.
      const beforeCount = [...lc.loader.entries()].length
      expect(beforeCount).toBeGreaterThanOrEqual(2)

      // Dispose the WHOLE tree (controller unload semantics).
      await c.fiber.dispose()

      // After full unload, every loader entry is gone.
      const loaderAfter = (
        c as unknown as {
          loader?: { entries?: () => Iterable<unknown> }
        }
      ).loader
      const remaining = loaderAfter?.entries ? [...loaderAfter.entries()] : []
      expect(remaining.length).toBe(0)

      // The handle set after unload must be a SUBSET of the pre-boot baseline.
      // Anything new is a resource the candidate/loader failed to release.
      const afterHandles = activeHandleNames()
      const leaked = afterHandles.filter((h) => !baselineHandles.includes(h))
      expect(leaked, `handles leaked beyond baseline after unload: ${leaked.join(',')}`).toEqual([])
    },
  )
})

/** Snapshot the constructor names of live Node async handles (timers/sockets/etc). */
function activeHandleNames(): string[] {
  return (
    (
      process as unknown as {
        _getActiveHandles?: () => { constructor?: { name?: string } }[]
      }
    )._getActiveHandles?.() ?? []
  )
    .map((h) => h.constructor?.name ?? 'anon')
    .sort()
}
