import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCandidate,
  canonicalV011,
  canonicalizeV011Tree,
  digestV011,
  freezeCapabilityCatalog,
  packCapsule,
  snapshotV011Tree,
  V011_PROTOCOL,
  type EvidenceCitation,
} from '@dsh-rsi/candidate-sdk'
import {
  materializeProposerExport,
  publishBytes,
  runProposalSandbox,
  type ProposalSandboxMounts,
} from '@dsh-rsi/core'
import {
  TrustedChatCompletionsAdapter,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayRoute,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const v1Baseline = join(repoRoot, 'packages', 'candidate-baseline')
const v011Baseline = join(repoRoot, 'packages', 'candidate-v011-baseline')
const dshRoot = join(repoRoot, 'deepseek-harness')
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc')
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]
const proposalId = 'p_11111111111111111111111111111111'
const digest = (character: string) => `sha256:${character.repeat(64)}`
const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://provider.invalid/v1',
  model: 'deepseek-v4-flash-zen',
  reasoningEffort: 'high',
  maxTokens: 32_768,
}
const realApiKey = process.env['RSI_PROVIDER_API_KEY'] ?? ''
const realBaseUrl = process.env['RSI_PROVIDER_BASE_URL'] ?? ''
const realRoute: ProposalGatewayRoute = {
  ...route,
  endpoint: realBaseUrl,
}

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function topology(selectedRoute: ProposalGatewayRoute = route): Promise<{
  mounts: ProposalSandboxMounts
  runtimeRoot: string
  request: Record<string, unknown>
  citations: [EvidenceCitation, EvidenceCitation]
}> {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-proposer-'))
  const receipt = await buildCandidate({ sourceRoot: v1Baseline, sourceFiles, tscBin })
  const capsule = join(root, 'capsule')
  await packCapsule({
    outDir: capsule,
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
        '@deepseek-ai/cordis-plugin-loader',
      ],
      entryPackage: '@dsh-rsi/proposer',
      entryBin: 'lib/v011-sandbox-worker.js',
    },
  })
  const runtimeRoot = join(capsule, 'runtime')
  await mkdir(join(runtimeRoot, 'selected-parent'), { recursive: true })
  await cp(join(v011Baseline, 'lib', 'index.js'), join(runtimeRoot, 'selected-parent', 'index.js'))
  const parentEntryDigest = `sha256:${createHash('sha256')
    .update(await readFile(join(runtimeRoot, 'selected-parent', 'index.js')))
    .digest('hex')}`
  const parentRuntimeDigest = `sha256:${createHash('sha256')
    .update(`index.js:${parentEntryDigest.replace('sha256:', '')}`)
    .digest('hex')}`
  const mounts = {
    parent: join(root, 'input', 'parent'),
    archive: join(root, 'input', 'archive'),
    evidence: join(root, 'input', 'evidence'),
    contracts: join(root, 'input', 'contracts'),
    childrenRoot: join(root, 'children'),
  }
  await Promise.all(
    [mounts.parent, mounts.archive, mounts.contracts, mounts.childrenRoot].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  )
  const parentTree = join(mounts.parent, 'tree')
  await mkdir(parentTree, { recursive: true })
  for (const path of ['src', 'tests'])
    await cp(join(v011Baseline, path), join(parentTree, path), { recursive: true })
  for (const path of [
    'package.json',
    'candidate.json',
    'cordis.patch.yml',
    'tsconfig.json',
    'README.md',
  ]) {
    await cp(join(v011Baseline, path), join(parentTree, path))
  }
  const slot = join(mounts.childrenRoot, proposalId)
  await mkdir(slot, { recursive: true })
  await cp(parentTree, join(slot, 'tree'), { recursive: true })
  await writeFile(join(mounts.archive, 'catalog.json'), '{"sourceLabel":"DEV_OBSERVED"}\n')
  const store = { root: join(root, 'object-store') }
  const atif = await publishBytes(
    store,
    Buffer.from('{"events":[{"error":"transient"}]}\n'),
    'application/vnd.dsh-rsi.atif+json',
    'DEV_OBSERVED',
  )
  const normalized = await publishBytes(
    store,
    Buffer.from('{"status":"fail","reward":0}\n'),
    'application/vnd.dsh-rsi.normalized-trial-record+json',
    'DEV_OBSERVED',
  )
  const exportManifest = await materializeProposerExport({
    store,
    outDir: mounts.evidence,
    exportId: 'v011-e2e-export',
    principal: 'proposer:e2e',
    objects: [atif, normalized],
    createdFromStateHash: digest('f'),
  })
  const catalog = await freezeCapabilityCatalog({
    schemaVersion: 1,
    protocol: V011_PROTOCOL,
    dshCommit: '4'.repeat(40),
    capabilities: [
      {
        id: 'systemPrompt',
        tier: 'T0',
        kind: 'service',
        signature: 'systemPrompt.section(input): disposer',
        enabled: true,
        fixtureDigest: digest('5'),
      },
    ],
  })
  await writeFile(join(mounts.contracts, 'capability-catalog.json'), JSON.stringify(catalog) + '\n')
  const parentDigest =
    `sha256:${(await canonicalizeV011Tree(await snapshotV011Tree(parentTree))).hash}` as const
  const exportManifestDigest = digestV011(canonicalV011(exportManifest))
  const request = {
    route: selectedRoute,
    proposalId,
    parentDigest,
    parentEntryDigest,
    parentRuntimeDigest,
    candidateId: digest('b'),
    exportManifestDigest,
    exportMerkleRoot: exportManifest.merkleRoot,
    capabilityCatalogDigest: catalog.digest,
    ancestorClusters: [],
  }
  await writeFile(join(mounts.contracts, 'request.json'), JSON.stringify(request) + '\n')
  await mkdir(join(mounts.contracts, 'schemas'), { recursive: true })
  for (const schema of [
    'v011.evidence-citation.schema.json',
    'v011.proposal.schema.json',
    'v011.analysis.schema.json',
    'v011.candidate-intent.schema.json',
  ]) {
    await cp(join(repoRoot, 'schemas', schema), join(mounts.contracts, 'schemas', schema))
  }
  const citations: [EvidenceCitation, EvidenceCitation] = [
    {
      objectDigest: `sha256:${atif.digest}`,
      mediaType: atif.mediaType,
      locator: { kind: 'json-pointer', value: '/events/0' },
      observation: 'The tool failed transiently.',
    },
    {
      objectDigest: `sha256:${normalized.digest}`,
      mediaType: normalized.mediaType,
      locator: { kind: 'json-pointer', value: '/status' },
      observation: 'The baseline trial failed.',
    },
  ]
  return { mounts, runtimeRoot, request, citations }
}

function call(index: number, name: string, args: unknown) {
  return {
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: `v011-${index}`, name, arguments: JSON.stringify(args) },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}

function stop(text: string) {
  return {
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  }
}

describe('v0.1.1 sandboxed trajectory-grounded proposer', () => {
  it(
    'loads the exact parent through Loader and authors a multi-file child with retained tools',
    { timeout: 180_000 },
    async () => {
      const { mounts, runtimeRoot, request, citations } = await topology()
      const [citation1, citation2] = citations
      const hypothesis =
        'One bounded retry after a transient tool error reaches normal finalization.'
      const candidate = {
        schemaVersion: 2,
        proposal: {
          hypothesis,
          targetFailureModes: ['transient-tool-stop'],
          expectedBehaviorChange: 'Retry exactly once.',
          regressionRisks: ['duplicate successful calls'],
          touchedSurfaces: ['systemPrompt'],
        },
        runtime: {
          requiredServices: ['systemPrompt'],
          optionalServices: [],
          newToolNames: [],
          supportsModes: ['solve', 'propose'],
        },
        tests: {
          mechanismAssertions: ['one retry maximum'],
          preservationAssertions: ['success is not retried'],
        },
      }
      const analysis = {
        schemaVersion: 1,
        failureClusters: [
          {
            slug: 'transient-tool-stop',
            mechanism: 'The agent stops after one transient tool error.',
            citations: [citation1, citation2],
          },
        ],
        ancestorReconciliations: [],
        selectedCluster: 'transient-tool-stop',
        falsifiableHypothesis: hypothesis,
        expectedBehaviorChange: 'Retry exactly once.',
        preservationRequirements: ['Do not repeat success.'],
        regressionRisks: ['Duplicate side effects.'],
      }
      const invalidAnalysis = {
        ...analysis,
        failureClusters: [
          {
            ...analysis.failureClusters[0],
            citations: [citation2],
          },
        ],
      }
      const proposal = {
        schemaVersion: 2,
        proposalId,
        canonicalParentDigest: request['parentDigest'],
        evidenceExport: {
          manifestDigest: request['exportManifestDigest'],
          merkleRoot: request['exportMerkleRoot'],
        },
        donorCandidates: [],
        analysisPath: 'analysis.json',
        hypothesis,
        evidenceCitations: [citation1, citation2],
        declaredOperations: [
          { op: 'modify', path: 'candidate.json' },
          { op: 'modify', path: 'src/index.ts' },
          { op: 'add', path: 'src/retry/bounded-retry.ts' },
          { op: 'add', path: 'tests/retry.spec.ts' },
        ],
        mechanismAssertions: ['one retry maximum'],
        preservationAssertions: ['success is not retried'],
        capabilityRequests: [],
      }
      const actions: Array<[string, unknown]> = [
        ['list_files', { root: 'evidence' }],
        ['read_file', { root: 'evidence', path: 'objects/trajectory.json' }],
        [
          'write_file',
          { path: 'src/retry/bounded-retry.ts', content: 'export const boundedRetryLimit = 1\n' },
        ],
        [
          'write_file',
          {
            path: 'src/index.ts',
            content: "export { boundedRetryLimit } from './retry/bounded-retry.js'\n",
          },
        ],
        [
          'write_file',
          {
            path: 'tests/retry.spec.ts',
            content:
              "import { describe, expect, it } from 'vitest'\ndescribe('retry',()=>it('is bounded',()=>expect(1).toBe(1)))\n",
          },
        ],
        ['write_file', { path: 'candidate.json', content: JSON.stringify(candidate) + '\n' }],
        ['write_file', { path: 'analysis.json', content: JSON.stringify(invalidAnalysis) + '\n' }],
        ['write_file', { path: 'proposal.json', content: JSON.stringify(proposal) + '\n' }],
        ['validate_child', {}],
        ['finish_proposal', {}],
        ['write_file', { path: 'analysis.json', content: JSON.stringify(analysis) + '\n' }],
        ['finish_proposal', {}],
      ]
      let turn = 0
      const gateway = await startProposalGateway({
        socketPath: join(root!, 'gateway', 'proposal.sock'),
        route,
        async handle() {
          const action = actions[turn]
          turn += 1
          return action === undefined
            ? stop('Proposal files are complete.')
            : call(turn, action[0], action[1])
        },
      })
      try {
        const result = await runProposalSandbox({
          mounts,
          runtimeRoot,
          command: '/runtime/node',
          args: ['/runtime/node_modules/@dsh-rsi/proposer/lib/v011-sandbox-worker.js'],
          timeoutMs: 120_000,
          maxOutputBytes: 2 * 1024 * 1024,
          gatewaySocket: gateway.socketPath,
        })
        expect(result.exitCode, result.stderr).toBe(0)
        const output = JSON.parse(
          await readFile(join(mounts.childrenRoot, proposalId, 'worker-output.json'), 'utf8'),
        ) as {
          parentLoader: { mode: string; entryDigest: string; runtimeDigest: string }
          toolCallCount: number
          transcript: { toolTrace: unknown[] }
        }
        expect(output.parentLoader).toEqual({
          entryId: 'rsi-selected-parent',
          package: '@dsh-rsi/selected-parent',
          mode: 'propose',
          entryDigest: request['parentEntryDigest'],
          runtimeDigest: request['parentRuntimeDigest'],
        })
        expect(output.toolCallCount).toBe(12)
        expect(output.transcript.toolTrace.length).toBeGreaterThanOrEqual(20)
        expect(
          await readFile(
            join(mounts.childrenRoot, proposalId, 'tree', 'src/retry/bounded-retry.ts'),
            'utf8',
          ),
        ).toContain('boundedRetryLimit')
        expect(gateway.receipts()).toHaveLength(13)
      } finally {
        await gateway.close()
      }
    },
  )

  it('detects a baseline substitute before any model request', { timeout: 180_000 }, async () => {
    const { mounts, runtimeRoot } = await topology()
    await writeFile(
      join(runtimeRoot, 'selected-parent', 'index.js'),
      'export function apply() {}\n',
    )
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'gateway', 'proposal.sock'),
      route,
      async handle() {
        return stop('must not be called')
      },
    })
    try {
      const result = await runProposalSandbox({
        mounts,
        runtimeRoot,
        command: '/runtime/node',
        args: ['/runtime/node_modules/@dsh-rsi/proposer/lib/v011-sandbox-worker.js'],
        timeoutMs: 120_000,
        gatewaySocket: gateway.socketPath,
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('selected parent runtime digest mismatch')
      expect(gateway.receipts()).toHaveLength(0)
    } finally {
      await gateway.close()
    }
  })
})

describe.skipIf(!realApiKey || !realBaseUrl)('v0.1.1 real-provider tool loop', () => {
  it(
    'uses retained tools to author a schema-valid multi-file child through the trusted gateway',
    { timeout: 900_000 },
    async () => {
      const { mounts, runtimeRoot } = await topology(realRoute)
      const adapter = new TrustedChatCompletionsAdapter({
        route: realRoute,
        apiKeyEnv: 'RSI_PROVIDER_API_KEY',
        expectedResponseModel: 'deepseek-v4-flash',
        contextWindow: 1_048_576,
        requestMaxRetries: 12,
        reasoningContinuationMaxTurns: 1,
      })
      const gateway = await startProposalGateway({
        socketPath: join(root!, 'gateway', 'proposal.sock'),
        route: realRoute,
        handle: createProposalGatewayLlmHandler(adapter, realRoute),
      })
      try {
        const result = await runProposalSandbox({
          mounts,
          runtimeRoot,
          command: '/runtime/node',
          args: ['/runtime/node_modules/@dsh-rsi/proposer/lib/v011-sandbox-worker.js'],
          timeoutMs: 1_800_000,
          maxOutputBytes: 4 * 1024 * 1024,
          gatewaySocket: gateway.socketPath,
        })
        expect(result.exitCode, result.stderr).toBe(0)
        const childRoot = join(mounts.childrenRoot, proposalId)
        const output = JSON.parse(
          await readFile(join(childRoot, 'worker-output.json'), 'utf8'),
        ) as {
          toolCallCount: number
          transcript: { eventCount: number; toolTrace: unknown[] }
        }
        expect(output.toolCallCount).toBeGreaterThanOrEqual(5)
        expect(output.transcript.eventCount).toBeGreaterThan(0)
        expect(output.transcript.toolTrace.length).toBeGreaterThanOrEqual(output.toolCallCount * 2)
        const proposal = JSON.parse(await readFile(join(childRoot, 'proposal.json'), 'utf8')) as {
          proposalId?: unknown
          declaredOperations?: Array<{ op?: unknown; path?: unknown }>
        }
        expect(proposal.proposalId).toBe(proposalId)
        expect(proposal.declaredOperations?.some((entry) => entry.op === 'add')).toBe(true)
        expect(
          proposal.declaredOperations?.some(
            (entry) => entry.op === 'modify' && entry.path === 'src/index.ts',
          ),
        ).toBe(true)
        expect(gateway.receipts().length).toBeGreaterThan(0)
        expect(gateway.receipts().length).toBeLessThanOrEqual(output.toolCallCount + 1)
      } finally {
        await gateway.close()
      }
    },
  )
})
