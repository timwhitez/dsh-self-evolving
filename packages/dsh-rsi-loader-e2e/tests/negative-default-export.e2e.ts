/**
 * Gate 0 — negative fixture (spec 07 §2 Accept, postmortem 0001).
 *
 * The DSH Loader normalizes a plugin module via `exports.default ?? exports`. A
 * module that declares BOTH namespace exports (`name`/`inject`/`Config`/`apply`)
 * AND `export default apply` is unwrapped to the bare default function, which
 * DROPS the sibling metadata. A hand-rolled `ctx.plugin({ name, inject, apply })`
 * test cannot catch this — only the real Loader unwraps the module.
 *
 * This fixture writes a candidate variant that adds `export default apply` and
 * boots it through the real Loader. It MUST fail to inject `systemPrompt` (the
 * dropped `inject` array is the smoking gun), proving the E2E harness catches
 * the defect. If this test ever passes (the inject resolves), the negative guard
 * has regressed and the Loader E2E no longer protects candidates.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'

const here = dirname(fileURLToPath(import.meta.url))
const dshRoot = resolve(here, '..', '..', '..', 'deepseek-harness')
const repoRoot = resolve(here, '..', '..', '..')

let root: string | undefined
let ctx: Context | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-neg-'))
})

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } catch {
    // swallow; the snapshot/guard is the real assertion
  }
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function linkPackage(scope: string, name: string, source: string): Promise<void> {
  const fixtureRoot = root as string
  const scopeDir = join(fixtureRoot, 'node_modules', scope)
  await mkdir(scopeDir, { recursive: true })
  await symlink(source, join(scopeDir, name), process.platform === 'win32' ? 'junction' : 'dir')
}

const NEG_TIMEOUT = { timeout: 60_000 }

describe('Gate 0 — negative default-export fixture', () => {
  it(
    'a candidate with `export default apply` loses inject metadata under the real Loader',
    NEG_TIMEOUT,
    async () => {
      const fixtureRoot = root as string
      await mkdir(join(fixtureRoot, 'node_modules'), { recursive: true })

      // Link the real DSH packages the rows resolve.
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

      // Build a BROKEN candidate package in the fixture: it adds
      // `export default apply` beside the namespace exports. The built baseline
      // (correct form) lives in the repo; this variant is the regression target.
      const brokenPkgDir = join(fixtureRoot, 'node_modules', '@dsh-rsi', 'candidate-broken')
      await mkdir(brokenPkgDir, { recursive: true })
      // Reuse the baseline source but append the fatal default export. We read
      // the baseline source and append `export default apply` to simulate the
      // exact mistake postmortem 0001 documents.
      const baselineSrc = await readFile(
        resolve(repoRoot, 'packages', 'candidate-baseline', 'lib', 'index.js'),
        'utf8',
      )
      // The compiled JS already exports name/inject/Config/apply as ES modules.
      // Append the default export to reproduce the unwrap defect.
      const brokenSrc = baselineSrc + '\nexport default apply\n'
      await writeFile(
        join(brokenPkgDir, 'package.json'),
        JSON.stringify({
          name: '@dsh-rsi/candidate-broken',
          type: 'module',
          main: './index.js',
          exports: { '.': './index.js', './package.json': './package.json' },
        }),
      )
      await writeFile(join(brokenPkgDir, 'index.js'), brokenSrc)

      // cordis.yml mounts the broken candidate + the service it claims to inject.
      const cordisYml = [
        '- id: system-prompt',
        "  name: '@deepseek-ai/dsh-system-prompt'",
        '  config: {}',
        '- id: rsi-candidate',
        "  name: '@dsh-rsi/candidate-broken'",
        '  config:',
        '    candidateId: broken',
        '    mode: solve',
        '',
      ].join('\n')
      await writeFile(join(fixtureRoot, 'cordis.yml'), cordisYml)

      ctx = new Context()
      ctx.baseUrl = pathToFileURL(join(fixtureRoot, 'cordis.yml')).href
      await ctx.plugin(Loader)

      const c = ctx as unknown as Context & {
        loader: {
          internal?: { version: string; import: (s: string) => Promise<unknown> }
          builtins: { include: unknown; group: unknown }
          create: (opts: { id: string; name: string; config: unknown }) => Promise<string>
          await: () => Promise<void>
          entries: () => Iterable<{ options: { id: string; name: string } }>
        }
      }
      const fixtureRequire = createRequire(join(fixtureRoot, 'package.json'))
      c.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          const resolved = fixtureRequire.resolve(specifier)
          return await import(pathToFileURL(resolved).href)
        },
      }
      c.loader.builtins.include = Include
      c.loader.builtins.group = Group
      // The broken candidate MUST be rejected by the real Loader. Because
      // `export default apply` made the Loader unwrap the module to a bare
      // function, the sibling `inject: ['systemPrompt']` was dropped (postmortem
      // 0001). The candidate's apply() then touches ctx.systemPrompt without a
      // declared inject and Cordis throws "cannot get property ... without inject"
      // at boot. A hand-rolled ctx.plugin() would never hit this path.
      await expect(
        c.loader
          .create({
            id: 'include',
            name: 'cordis:include',
            config: { path: pathToFileURL(join(fixtureRoot, 'cordis.yml')).href },
          })
          .then(() => c.loader.await()),
      ).rejects.toThrow(/cannot get property "systemPrompt" without inject|default/)
    },
  )
})
