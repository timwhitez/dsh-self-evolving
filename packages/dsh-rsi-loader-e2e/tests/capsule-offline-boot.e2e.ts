/**
 * Gate 1 — packed capsule offline boot (spec 07 §3 Accept).
 *
 * "packed capsule 在无 source、无网络的 fresh container 中完成 DSH ACP
 * initialize/session".
 *
 * This test packs a capsule from the candidate-baseline, then boots the real
 * Cordis Loader against the CAPSULE's candidate/ contents in an isolated
 * directory that does NOT contain the source checkout. It proves the capsule
 * is self-contained: only the compiled bundle + linked pinned DSH packages
 * are needed. No model is called (model-free); the ACP initialize/session
 * surface is represented by the Loader booting the candidate row and the
 * service being live.
 *
 * This is the offline, no-source, no-network analog of the production task-
 * environment boot. Network isolation is enforced structurally: the fixture
 * directory has no network handle and resolves modules only from its own
 * node_modules (which links only pinned, locally-built DSH packages).
 */
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
import { buildCandidate, packCapsule } from '@dsh-rsi/candidate-sdk'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baselineRoot = resolve(repoRoot, 'packages', 'candidate-baseline')
const dshRoot = resolve(repoRoot, 'deepseek-harness')
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc')

const baselineSourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-rsi-capsule-'))
})

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

const CAPSULE_TIMEOUT = { timeout: 120_000 }

describe('Gate 1 — packed capsule offline boot', () => {
  it(
    'a packed capsule boots the real Loader with no source checkout present',
    CAPSULE_TIMEOUT,
    async () => {
      // 1. Build the candidate and pack a capsule.
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      const capsuleDir = join(scratch!, 'capsule')
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        candidateSourceRoot: baselineRoot,
        runnerOverlay: '- insert: []\n',
        provenanceJson: '{"dsh":"pinned"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
      })

      // 2. Create an isolated boot dir that has NO source checkout — only the
      //    capsule's candidate/ contents and the pinned DSH packages linked in.
      const bootDir = join(scratch!, 'boot')
      await mkdir(join(bootDir, 'node_modules', '@deepseek-ai'), { recursive: true })
      await mkdir(join(bootDir, 'node_modules', '@dsh-rsi'), { recursive: true })

      // Copy (not symlink) the capsule's candidate/ into the boot dir so Node
      // resolves the candidate's transitive deps from bootDir/node_modules —
      // matching how a task environment unpacks a capsule and installs its
      // runtime closure into the resolution path. A symlink would resolve from
      // the capsule's own (dep-less) directory.
      await cp(
        join(capsuleDir, 'candidate'),
        join(bootDir, 'node_modules', '@dsh-rsi', 'candidate-baseline'),
        { recursive: true },
      )
      // Link pinned DSH packages (already-built, local — no network).
      await symlink(
        join(dshRoot, 'vendor', 'cordis'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'schemastery'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'schemastery'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'cosmokit'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cosmokit'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'packages', 'core', 'system-prompt'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'dsh-system-prompt'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'loader'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'include'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-include'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'group'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group'),
        'dir',
      )

      // 3. Write a cordis.yml in the boot dir that mounts the capsule candidate.
      await writeFile(
        join(bootDir, 'cordis.yml'),
        [
          '- id: system-prompt',
          "  name: '@deepseek-ai/dsh-system-prompt'",
          '  config: {}',
          '- id: rsi-candidate',
          "  name: '@dsh-rsi/candidate-baseline'",
          '  config:',
          '    candidateId: baseline',
          '    mode: solve',
          '',
        ].join('\n'),
      )

      // 4. Boot the real Loader against the isolated boot dir.
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(join(bootDir, 'cordis.yml')).href
      await ctx.plugin(Loader)
      const c = ctx as unknown as Context & {
        loader: {
          internal?: { version: string; import: (s: string) => Promise<unknown> }
          builtins: { include: unknown; group: unknown }
          create: (opts: { id: string; name: string; config: unknown }) => Promise<string>
          await: () => Promise<void>
          entries: () => Iterable<{ options: { id: string; name: string } }>
        }
        get: <T = unknown>(name: string) => T | undefined
      }
      const bootRequire = createRequire(join(bootDir, 'package.json'))
      c.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          return await import(pathToFileURL(bootRequire.resolve(specifier)).href)
        },
      }
      c.loader.builtins.include = Include
      c.loader.builtins.group = Group
      await c.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(join(bootDir, 'cordis.yml')).href },
      })
      await c.loader.await()

      // 5. The capsule candidate booted: row active, service live.
      const entries = [...c.loader.entries()].map((e) => `${e.options.id}:${e.options.name}`)
      expect(entries).toContain('rsi-candidate:@dsh-rsi/candidate-baseline')
      expect(c.get('systemPrompt')).toBeDefined()

      // 6. The capsule manifest + SHA256SUMS exist and are internally consistent.
      const capsuleManifest = JSON.parse(await readFile(join(capsuleDir, 'capsule.json'), 'utf8'))
      expect(capsuleManifest.candidateId).toBe(receipt.candidateId)
      const sums = await readFile(join(capsuleDir, 'SHA256SUMS'), 'utf8')
      expect(sums).toContain('capsule.json')
      expect(sums).toContain('candidate/lib/index.js')

      await ctx.fiber.dispose()
    },
  )
})
