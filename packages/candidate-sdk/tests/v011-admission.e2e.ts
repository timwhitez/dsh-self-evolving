import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { admitV011Candidate, digestV011 } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baseline = join(repoRoot, 'packages', 'candidate-v011-baseline')
const dshRoot = join(repoRoot, 'deepseek-harness')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function childFixture(failingTest = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-admission-'))
  roots.push(root)
  const child = join(root, 'child')
  await mkdir(child, { recursive: true })
  for (const path of ['src', 'tests'])
    await cp(join(baseline, path), join(child, path), { recursive: true })
  for (const path of [
    'package.json',
    'candidate.json',
    'cordis.patch.yml',
    'tsconfig.json',
    'README.md',
  ]) {
    await cp(join(baseline, path), join(child, path))
  }
  await mkdir(join(child, 'src', 'retry'), { recursive: true })
  await writeFile(
    join(child, 'src', 'retry', 'bounded-retry.ts'),
    [
      "import type { Context } from '@deepseek-ai/cordis'",
      "import type {} from '@deepseek-ai/dsh-system-prompt'",
      "export const name = 'candidate-bounded-retry'",
      "export const inject = ['systemPrompt']",
      'export const boundedRetryLimit = 1',
      'export function apply(ctx: Context): void {',
      "  ctx.systemPrompt.section({ name: 'candidate:bounded-retry', order: 101, text: 'Retry one transient tool failure at most once.' })",
      '}',
      '',
    ].join('\n'),
  )
  const original = await readFile(join(baseline, 'src', 'index.ts'), 'utf8')
  const source = original
    .replace(
      "import type {} from '@deepseek-ai/dsh-system-prompt'",
      "import type {} from '@deepseek-ai/dsh-system-prompt'\nimport * as BoundedRetry from './retry/bounded-retry.js'",
    )
    .replace(
      'export function apply(ctx: Context, config: Config): void {',
      'export function apply(ctx: Context, config: Config): void {\n  ctx.plugin(BoundedRetry)',
    )
  await writeFile(join(child, 'src', 'index.ts'), source)
  await writeFile(
    join(child, 'tests', 'retry.spec.ts'),
    [
      "import { describe, expect, it } from 'vitest'",
      "import { Config as RootConfig } from '../src/index.js'",
      "import { boundedRetryLimit } from '../src/retry/bounded-retry.js'",
      "describe('bounded retry', () => {",
      `  it('is exactly one', () => expect(boundedRetryLimit).toBe(${failingTest ? 2 : 1}))`,
      "  it('loads the candidate root with its runtime schema dependency', () => expect(RootConfig).toBeDefined())",
      '})',
      '',
    ].join('\n'),
  )
  const intent = JSON.parse(await readFile(join(child, 'candidate.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const proposal = intent['proposal'] as Record<string, unknown>
  proposal['hypothesis'] =
    'One bounded retry after a transient tool error reaches normal finalization.'
  proposal['targetFailureModes'] = ['transient-tool-stop']
  proposal['expectedBehaviorChange'] = 'One transient failure is retried once.'
  proposal['regressionRisks'] = ['A successful call could be duplicated.']
  intent['tests'] = {
    mechanismAssertions: ['The retry limit is exactly one.'],
    preservationAssertions: ['Successful calls remain single-shot.'],
  }
  await writeFile(join(child, 'candidate.json'), JSON.stringify(intent, null, 2) + '\n')
  return child
}

describe('v0.1.1 generated-plugin admission', () => {
  it(
    'runs candidate tests, double build, real Loader in both modes, and offline capsule',
    { timeout: 180_000 },
    async () => {
      const child = await childFixture()
      const outputRoot = join(dirname(child), 'capsule')
      const result = await admitV011Candidate({
        sourceRoot: child,
        toolchainRoot: repoRoot,
        tscBin: join(repoRoot, 'node_modules', '.bin', 'tsc'),
        materializationDigest: digestV011('materialization'),
        capabilityCatalogDigest: digestV011('catalog'),
        capsuleOutDir: outputRoot,
        runtimeClosure: {
          catalogRoots: [
            join(repoRoot, 'packages'),
            join(dshRoot, 'packages'),
            join(dshRoot, 'vendor'),
          ],
          seedPackages: ['@dsh-rsi/candidate-sdk'],
          entryPackage: '@dsh-rsi/candidate-sdk',
          entryBin: 'lib/v011/loader-probe-worker.js',
        },
        runnerOverlay: '\n',
        provenanceJson: '{"protocol":"dsh-rsi-candidate-tree-v2"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
      })
      expect(result.receipt.admitted).toBe(true)
      expect(result.buildReceipt.doubleBuildIdentical).toBe(true)
      expect(result.buildReceipt.runtimePackageName).toMatch(/^@dsh-rsi\/candidate-/)
      expect(result.loader.solve.promptSections).toContain('candidate:bounded-retry')
      expect(result.loader.propose.promptSections).toContain('candidate:bounded-retry')
      expect(result.loader.solve.leakedHandles).toEqual([])
      expect(result.loader.propose.leakedHandles).toEqual([])
      expect(result.receipt.stageReceipts.fixedReplay).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect((await stat(join(outputRoot, 'runtime', 'node'))).isFile()).toBe(true)
      expect(await stat(join(child, 'lib')).catch(() => null)).toBeNull()
    },
  )

  it(
    'stops before build/capsule when a candidate-owned test fails',
    { timeout: 120_000 },
    async () => {
      const child = await childFixture(true)
      const outputRoot = join(dirname(child), 'rejected-capsule')
      await expect(
        admitV011Candidate({
          sourceRoot: child,
          toolchainRoot: repoRoot,
          tscBin: join(repoRoot, 'node_modules', '.bin', 'tsc'),
          materializationDigest: digestV011('materialization'),
          capabilityCatalogDigest: digestV011('catalog'),
          capsuleOutDir: outputRoot,
          runtimeClosure: {
            catalogRoots: [
              join(repoRoot, 'packages'),
              join(dshRoot, 'packages'),
              join(dshRoot, 'vendor'),
            ],
            seedPackages: ['@dsh-rsi/candidate-sdk'],
            entryPackage: '@dsh-rsi/candidate-sdk',
            entryBin: 'lib/v011/loader-probe-worker.js',
          },
          runnerOverlay: '\n',
          provenanceJson: '{}',
          sbomJson: '{}',
        }),
      ).rejects.toThrow(/candidate tests failed/)
      expect(await stat(outputRoot).catch(() => null)).toBeNull()
    },
  )
})
