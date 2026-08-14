/** Gate 4: real DSH proposer composition runs inside Bubblewrap via Unix gateway. */
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCandidate, packCapsule } from '@dsh-rsi/candidate-sdk'
import { runProposalSandbox, type ProposalSandboxMounts } from '@dsh-rsi/core'
import { startProposalGateway, type ProposalGatewayRoute } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baselineRoot = join(repoRoot, 'packages', 'candidate-baseline')
const dshRoot = join(repoRoot, 'deepseek-harness')
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc')
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

const route: ProposalGatewayRoute = {
  provider: 'deepseek-official',
  endpoint: 'https://provider.invalid/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 2048,
}

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-sandboxed-dsh-proposer-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function makeMounts(): Promise<ProposalSandboxMounts> {
  const mounts = {
    parent: join(root!, 'input', 'parent'),
    archive: join(root!, 'input', 'archive'),
    evidence: join(root!, 'input', 'evidence'),
    contracts: join(root!, 'input', 'contracts'),
    childrenRoot: join(root!, 'children'),
  }
  await Promise.all(Object.values(mounts).map((path) => mkdir(path, { recursive: true })))
  await mkdir(join(mounts.parent, 'src'), { recursive: true })
  await cp(join(baselineRoot, 'src', 'index.ts'), join(mounts.parent, 'src', 'index.ts'))
  await writeFile(
    join(mounts.archive, 'catalog.json'),
    JSON.stringify({ schemaVersion: 1, sourceLabel: 'DEV_OBSERVED', candidates: [] }) + '\n',
  )
  await writeFile(
    join(mounts.evidence, 'traces.txt'),
    'DEV_OBSERVED trace: transient tool failure; retry once with a strict bound.\n',
  )
  return mounts
}

describe('Gate 4 — sandboxed real DSH proposal topology', () => {
  it(
    'runs agent-spine + propose candidate through the broker and validates one child',
    { timeout: 180_000 },
    async () => {
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles,
        tscBin,
      })
      const capsuleDir = join(root!, 'capsule')
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        runnerOverlay: '\n',
        provenanceJson: '{"dsh":"pinned"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
        runtimeClosure: {
          catalogRoots: [
            join(repoRoot, 'packages'),
            join(dshRoot, 'packages'),
            join(dshRoot, 'vendor'),
          ],
          seedPackages: [
            '@dsh-rsi/proposer',
            '@deepseek-ai/dsh-agent-spine-demo',
            '@deepseek-ai/dsh-agent-default-model',
          ],
          entryPackage: '@dsh-rsi/proposer',
          entryBin: 'lib/sandbox-worker.js',
        },
      })
      const mounts = await makeMounts()
      const parentDigest = `sha256:${receipt.sourceHash}`
      await writeFile(
        join(mounts.contracts, 'request.json'),
        JSON.stringify({
          route,
          parentDigest,
          candidateId: receipt.candidateId,
          width: 3,
        }) + '\n',
      )

      const proposal = {
        proposalId: 'sandboxed-p1',
        canonicalParentDigest: parentDigest,
        donorCandidates: [],
        hypothesis: 'Retry exactly once after a transient tool failure to improve bounded recovery',
        evidenceRefs: ['evidence://dev/trace-1'],
        mechanismTests: ['a transient failure triggers exactly one retry'],
        preservationTests: ['a successful first call is never repeated'],
        sourceDiff: '@@ -1,1 +1,2 @@\n+export const boundedRetry = 1',
      }
      const assistantText = JSON.stringify(proposal)
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: assistantText },
        { type: 'block-end', index: 0, block: { type: 'text', text: assistantText } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const gateway = await startProposalGateway({
        socketPath: join(root!, 'gateway', 'proposal.sock'),
        route,
        async handle(payload) {
          expect(JSON.stringify(payload)).toContain('DEV_OBSERVED')
          expect(JSON.stringify(payload)).not.toContain('DEEPSEEK_API_KEY')
          return { chunks }
        },
      })
      try {
        const result = await runProposalSandbox({
          mounts,
          runtimeRoot: join(capsuleDir, 'runtime'),
          command: '/runtime/node',
          args: ['/runtime/node_modules/@dsh-rsi/proposer/lib/sandbox-worker.js'],
          timeoutMs: 120_000,
          maxOutputBytes: 2 * 1024 * 1024,
          gatewaySocket: gateway.socketPath,
        })
        expect(result.exitCode, result.stderr).toBe(0)
        const output = JSON.parse(
          await readFile(join(mounts.childrenRoot, 'proposal-output.json'), 'utf8'),
        ) as { transcript: { eventCount: number }; parsed: { accepted: unknown[] } }
        expect(output.transcript.eventCount).toBeGreaterThan(0)
        expect(output.parsed.accepted).toHaveLength(1)
        expect(gateway.receipts()).toHaveLength(1)
      } finally {
        await gateway.close()
      }
    },
  )
})
