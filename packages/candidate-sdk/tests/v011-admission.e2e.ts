import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { admitV011Candidate, digestV011, verifyV011PackedOverlayBytes } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baseline = join(repoRoot, 'packages', 'candidate-v011-baseline')
const dshRoot = join(repoRoot, 'deepseek-harness')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function childFixture(failingTest = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-admission-'))
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
          seedPackages: [
            '@deepseek-ai/dsh-acp-demo',
            '@dsh-self-evolving/llm-responses',
            '@deepseek-ai/dsh-sandbox-local',
            '@deepseek-ai/dsh-sandbox-policy',
            '@deepseek-ai/dsh-subprocess-local',
            '@deepseek-ai/dsh-bash-sandbox',
            '@deepseek-ai/dsh-user-approval',
          ],
          entryPackage: '@deepseek-ai/dsh-acp-demo',
          entryBin: 'lib/bin.js',
        },
        runnerOverlay: [
          '- id: deepseek-responses',
          "  name: '@dsh-self-evolving/llm-responses'",
          '  config:',
          '    apiKeyEnv: SHOULD_NOT_EXIST_IN_PACKED_OVERLAY_PROBE',
          '    reasoningEffort: high',
          '    maxTokens: 1024',
          '    defaultContextWindow: 1048576',
          '- id: sandbox',
          "  name: '@deepseek-ai/dsh-sandbox-local'",
          '- id: sandbox-policy',
          "  name: '@deepseek-ai/dsh-sandbox-policy'",
          '  config:',
          '    mode: danger-full-access',
          '    workspaceRoot: !!js process.cwd()',
          '- id: subprocess',
          "  name: '@deepseek-ai/dsh-subprocess-local'",
          '- id: bash',
          "  name: '@deepseek-ai/dsh-bash-sandbox'",
          '  config:',
          '    timeoutMs: 60000',
          '- id: approval',
          "  name: '@deepseek-ai/dsh-user-approval'",
          '  config:',
          '    policy: never',
          '- id: acp-agent',
          "  name: '@deepseek-ai/dsh-acp-demo'",
          '  config:',
          '    provider: deepseek-official',
          '    model: deepseek-v4-flash',
          '    persistenceRoot: /logs/agent/dsh-sessions',
          '    persistenceCompression: none',
          '    workspaceContext: false',
          '    skills:',
          '      enabled: false',
          '    toolJobs: false',
          '    goals: false',
          '- id: self-evolving-candidate',
          "  name: '__DSH_SELF_EVOLVING_RUNTIME_PACKAGE__'",
          '  config:',
          '    candidateId: __DSH_SELF_EVOLVING_CANDIDATE_ID__',
          '    mode: solve',
          '',
        ].join('\n'),
        provenanceJson: '{"protocol":"dsh-self-evolving-candidate-tree-v2"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
      })
      expect(result.receipt.admitted).toBe(true)
      expect(result.buildReceipt.doubleBuildIdentical).toBe(true)
      const capsuleManifest = JSON.parse(
        await readFile(join(outputRoot, 'capsule.json'), 'utf8'),
      ) as {
        candidateId: string
        candidate: { buildCandidateId: string }
      }
      // The v0.1.1 admission digest is the one canonical identity consumed by
      // the controller, overlay, capsule and evaluator. Preserve the SDK's
      // c_<base32> build identity as an explicit cross-binding instead of
      // letting it silently replace the controller identity (issue #198).
      expect(capsuleManifest.candidateId).toBe(result.receipt.candidateDigest)
      expect(capsuleManifest.candidate.buildCandidateId).toBe(result.buildReceipt.candidateId)
      expect(result.receipt.buildCandidateId).toBe(result.buildReceipt.candidateId)
      // The packed runtime must receive the EXACT admitted identity, never a
      // placeholder (issue #114): the overlay is rewritten with the digest
      // before it lands in the capsule.
      const packedOverlay = await readFile(join(outputRoot, 'runner', 'cordis.patch.yml'), 'utf8')
      // The launcher boots runtime/cordis.yml; pin BOTH copies to the
      // admitted identity.
      const bootedOverlay = await readFile(join(outputRoot, 'runtime', 'cordis.yml'), 'utf8')
      expect(packedOverlay).not.toContain('__DSH_SELF_EVOLVING_RUNTIME_PACKAGE__')
      expect(packedOverlay).not.toContain('__DSH_SELF_EVOLVING_CANDIDATE_ID__')
      expect(packedOverlay).not.toContain('v011-runtime-candidate')
      expect(packedOverlay).toContain(`candidateId: sha256:${result.buildReceipt.sourceHash}`)
      expect(bootedOverlay).toContain(`candidateId: sha256:${result.buildReceipt.sourceHash}`)
      expect(bootedOverlay).not.toContain('__DSH_SELF_EVOLVING_')
      expect(result.loader.solve.candidateId).toBe(`sha256:${result.buildReceipt.sourceHash}`)
      expect(result.loader.propose.candidateId).toBe(`sha256:${result.buildReceipt.sourceHash}`)
      expect(result.buildReceipt.runtimePackageName).toMatch(/^@dsh-self-evolving\/candidate-/)
      expect(result.loader.solve.promptSections).toContain('candidate:bounded-retry')
      expect(result.loader.propose.promptSections).toContain('candidate:bounded-retry')
      expect(result.loader.solve.leakedHandles).toEqual([])
      expect(result.loader.propose.leakedHandles).toEqual([])
      const packedOverlayBytes = await readFile(join(outputRoot, 'runner', 'cordis.patch.yml'))
      expect(result.packedOverlay).toMatchObject({
        candidateId: `sha256:${result.buildReceipt.sourceHash}`,
        authoritativeOverlayRef: 'runner/cordis.patch.yml',
        bootedConfigRef: 'runtime/cordis.yml',
        byteIdentical: true,
        runtimeSettled: true,
        sessionCreated: true,
      })
      expect(result.packedOverlay.overlayDigest).toBe(
        `sha256:${createHash('sha256').update(packedOverlayBytes).digest('hex')}`,
      )
      expect(result.receipt.stageReceipts.packedOverlayBoot).toBe(digestV011(result.packedOverlay))
      expect(result.receipt.stageReceipts.fixedReplay).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect((await stat(join(outputRoot, 'runtime', 'node'))).isFile()).toBe(true)
      expect(await stat(join(child, 'lib')).catch(() => null)).toBeNull()

      // A post-pack divergence between the audit-facing runner file and the
      // actually booted runtime config must fail closed, even if both remain
      // individually valid YAML.
      await writeFile(join(outputRoot, 'runtime', 'cordis.yml'), `${bootedOverlay}\n# drift\n`)
      await expect(verifyV011PackedOverlayBytes(outputRoot)).rejects.toThrow(
        /runner\/runtime overlays differ/,
      )
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
            seedPackages: ['@dsh-self-evolving/candidate-sdk'],
            entryPackage: '@dsh-self-evolving/candidate-sdk',
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
