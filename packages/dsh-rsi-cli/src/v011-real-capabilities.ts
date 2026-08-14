import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  admitV011Candidate,
  assertV011,
  buildCandidate,
  canonicalizeV011Tree,
  canonicalV011,
  digestV011,
  freezeCapabilityCatalog,
  materializeV011ChildSlot,
  reserveProposalId,
  snapshotV011Tree,
  V011_PROTOCOL,
  type FrozenCapabilityCatalog,
} from '@dsh-rsi/candidate-sdk'
import {
  materializeProposerExport,
  materializeV011Proposal,
  publishBytes,
  readControllerStatus,
  recoverV011OutcomeDerivation,
  runProposalSandbox,
  type ObjectRef,
  type ObjectStore,
} from '@dsh-rsi/core'
import {
  TrustedChatCompletionsAdapter,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayRoute,
} from '@dsh-rsi/proposer'
import type { V011DemoConfig } from './config.js'
import type {
  BuiltCandidate,
  StableBuildInput,
  StableDemoCapabilities,
  StableProposal,
  StableProposalInput,
} from './engine.js'
import { runDoctor } from './doctor.js'
import { loadTrustedRoute } from './trusted-route.js'
import {
  createRealEvaluationProvider,
  selectFailureSeekingObservedTasks,
} from './real-capabilities.js'

const V1_SOURCE_FILES = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]
const SCHEMAS = [
  'v011.evidence-citation.schema.json',
  'v011.proposal.schema.json',
  'v011.analysis.schema.json',
  'v011.candidate-intent.schema.json',
  'v011.mechanism-outcome.schema.json',
  'v011.capability-catalog.schema.json',
  'v011.materialization-receipt.schema.json',
  'v011.admission-receipt.schema.json',
  'v011.migration-receipt.schema.json',
]

function sha(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function writeExclusive(path: string, bytes: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', mode)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  if ((await stat(root).catch(() => null))?.isDirectory()) await visit(root)
  return output.sort()
}

async function treeDigest(root: string): Promise<`sha256:${string}`> {
  const rows = await Promise.all(
    (await walk(root)).map(
      async (path) =>
        `${path.slice(root.length + 1)}:${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}`,
    ),
  )
  return sha(rows.join('\n'))
}

function evidenceMedia(path: string): string | null {
  const name = basename(path)
  if (name === 'trajectory.json') return 'application/vnd.dsh-rsi.atif+json'
  if (name === 'summary.json') return 'application/vnd.dsh-rsi.normalized-trial-record+json'
  if (name === 'acp-events.jsonl') return 'application/vnd.dsh-rsi.acp-events+jsonl'
  if (name === 'acp-summary.json') return 'application/vnd.dsh-rsi.acp-summary+json'
  if (name === 'session.jsonl') return 'application/vnd.dsh-rsi.dsh-session+jsonl'
  if (name === 'analysis.json') return 'application/vnd.dsh-rsi.analysis+json'
  if (name === 'outcome.json') return 'application/vnd.dsh-rsi.mechanism-outcome+json'
  if (name === 'rejection.json') return 'application/vnd.dsh-rsi.rejection+json'
  return null
}

async function collectEvidence(config: V011DemoConfig, store: ObjectStore): Promise<ObjectRef[]> {
  const roots = [
    join(config.stateDir, 'external-evaluator'),
    join(config.stateDir, 'v011', 'actions'),
    join(config.stateDir, 'v011', 'outcomes'),
  ]
  const refs: ObjectRef[] = []
  for (const root of roots) {
    for (const path of await walk(root)) {
      const mediaType = evidenceMedia(path)
      if (mediaType === null) continue
      const bytes = await readFile(path)
      if (bytes.byteLength > 16 * 1024 * 1024) continue
      refs.push(await publishBytes(store, bytes, mediaType, 'DEV_OBSERVED'))
    }
  }
  const unique = new Map(refs.map((ref) => [ref.digest, ref]))
  return [...unique.values()].sort((left, right) => left.digest.localeCompare(right.digest))
}

async function capabilityCatalog(config: V011DemoConfig): Promise<FrozenCapabilityCatalog> {
  const path = join(config.stateDir, 'v011', 'capability-catalog.json')
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing !== null) {
    const parsed = JSON.parse(existing) as FrozenCapabilityCatalog
    const verified = await freezeCapabilityCatalog(parsed.catalog)
    if (verified.digest !== parsed.digest)
      throw new Error('v0.1.1 catalog: durable digest mismatch')
    return verified
  }
  const receipt = digestV011('v011-default-capability-fixtures-pass')
  const frozen = await freezeCapabilityCatalog({
    schemaVersion: 1,
    protocol: V011_PROTOCOL,
    dshCommit: '47f943859bef60e4160492346772ded9b24f765a',
    capabilities: [
      {
        id: 'systemPrompt',
        tier: 'T0',
        kind: 'service',
        signature: 'systemPrompt.section(input): disposer',
        enabled: true,
        fixtureDigest: receipt,
      },
      {
        id: 'candidate-internal-composition',
        tier: 'T1',
        kind: 'composition',
        signature: 'ctx.plugin(namespaceComponent, config)',
        enabled: true,
        fixtureDigest: receipt,
      },
      {
        id: 'tools/result',
        tier: 'T1',
        kind: 'event',
        signature: 'emit-only observation',
        enabled: false,
        fixtureDigest: null,
      },
      {
        id: 'tools/pre-execute',
        tier: 'T2',
        kind: 'event',
        signature: 'waterfall(next)',
        enabled: false,
        fixtureDigest: null,
      },
      {
        id: 'agent/request',
        tier: 'T3',
        kind: 'event',
        signature: 'privileged model request mutation',
        enabled: false,
        fixtureDigest: null,
      },
    ],
  })
  await writeExclusive(path, JSON.stringify(frozen, null, 2) + '\n')
  return frozen
}

function solverOverlay(config: V011DemoConfig, baseUrl: string): string {
  return [
    '- id: deepseek-llm',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    `    baseURL: ${JSON.stringify(baseUrl)}`,
    '    thinking: enabled',
    '    reasoningEffort: high',
    `    maxTokens: ${config.model.maxOutputTokens}`,
    `    defaultContextWindow: ${config.model.contextWindow}`,
    '    models:',
    `      - id: ${config.model.requested}`,
    `        name: ${config.model.requested}`,
    `        contextWindow: ${config.model.contextWindow}`,
    `        maxTokens: ${config.model.maxOutputTokens}`,
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
    `    model: ${config.model.requested}`,
    '    persistenceRoot: /logs/agent/dsh-sessions',
    '    persistenceCompression: none',
    '    workspaceContext: false',
    '    skills:',
    '      enabled: false',
    '    toolJobs: false',
    '    goals: false',
    "    persona: 'DSH RSI v0.1.1 candidate. Solve autonomously with bounded tools and verify the task result.'",
    '- id: rsi-candidate',
    "  name: '__DSH_RSI_RUNTIME_PACKAGE__'",
    '  config:',
    '    candidateId: v011-runtime-candidate',
    '    mode: solve',
    '',
  ].join('\n')
}

function solverRuntime(config: V011DemoConfig) {
  const dsh = join(config.repoRoot, 'deepseek-harness')
  return {
    catalogRoots: [join(config.repoRoot, 'packages'), join(dsh, 'packages'), join(dsh, 'vendor')],
    seedPackages: [
      '@deepseek-ai/dsh-acp-demo',
      '@deepseek-ai/dsh-llm-deepseek',
      '@deepseek-ai/dsh-sandbox-local',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-subprocess-local',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-user-approval',
    ],
    entryPackage: '@deepseek-ai/dsh-acp-demo',
    entryBin: 'lib/bin.js',
  }
}

const credentialLauncher = [
  '#!/bin/sh',
  'set -eu',
  'runtime=${0%/*}',
  'secret_file=${RSI_PROVIDER_SECRET_FILE:-/run/dsh-rsi/provider.secret}',
  'test -f "$secret_file"',
  'DEEPSEEK_API_KEY=$(cat -- "$secret_file")',
  'test -n "$DEEPSEEK_API_KEY"',
  'export DEEPSEEK_API_KEY',
  'unset RSI_PROVIDER_SECRET_FILE',
  'exec "$runtime/dsh-rsi-acp" "$@"',
  '',
].join('\n')

async function copyBaselineTree(config: V011DemoConfig, destination: string): Promise<void> {
  const source = join(config.repoRoot, 'packages', 'candidate-v011-baseline')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const path of ['src', 'tests'])
    await cp(join(source, path), join(destination, path), { recursive: true })
  for (const path of [
    'package.json',
    'candidate.json',
    'cordis.patch.yml',
    'tsconfig.json',
    'README.md',
  ]) {
    await cp(join(source, path), join(destination, path))
  }
}

async function prepareBaseline(
  config: V011DemoConfig,
  catalog: FrozenCapabilityCatalog,
  baseUrl: string,
): Promise<BuiltCandidate> {
  const root = join(config.stateDir, 'candidates', 'v011-baseline')
  const recordPath = join(root, 'stable-build.json')
  const existing = await readFile(recordPath, 'utf8').catch(() => null)
  if (existing !== null) return JSON.parse(existing) as BuiltCandidate
  if ((await stat(root).catch(() => null)) !== null)
    throw new Error('v0.1.1 baseline: incomplete prior directory')
  const staging = `${root}.staging`
  const tree = join(staging, 'tree')
  await copyBaselineTree(config, tree)
  const v1Root = join(config.repoRoot, 'packages', 'candidate-baseline')
  const v1 = await buildCandidate({
    sourceRoot: v1Root,
    sourceFiles: V1_SOURCE_FILES,
    tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
  })
  const v011Archive = await canonicalizeV011Tree(await snapshotV011Tree(tree))
  const migration = {
    schemaVersion: 1,
    protocol: V011_PROTOCOL,
    v01ReleaseCommit: '796201dfe11d1ccf66ef2d6226a4e06cfa27d0b4',
    v01SourceDigest: `sha256:${v1.sourceHash}`,
    v011SourceDigest: `sha256:${v011Archive.hash}`,
    mapping: 'BEHAVIOR_BYTES_PRESERVED_IDENTITY_FIELDS_REMOVED',
    inheritedResultsPolicy: 'none',
  }
  await assertV011('migration-receipt', migration)
  await writeFile(join(staging, 'migration-receipt.json'), canonicalV011(migration) + '\n', {
    mode: 0o600,
  })
  const admission = await admitV011Candidate({
    sourceRoot: tree,
    toolchainRoot: config.repoRoot,
    tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
    materializationDigest: digestV011(migration),
    capabilityCatalogDigest: catalog.digest,
    capsuleOutDir: join(staging, 'capsule'),
    runtimeClosure: solverRuntime(config),
    runnerOverlay: solverOverlay(config, baseUrl),
    runnerFiles: { 'credential-launcher.sh': credentialLauncher },
    provenanceJson: JSON.stringify({ protocol: V011_PROTOCOL, model: config.model }),
    sbomJson: JSON.stringify({ spdxVersion: 'SPDX-2.3' }),
  })
  if (admission.buildReceipt.runtimePackageName === undefined) {
    throw new Error('v0.1.1 baseline: runtime package identity missing')
  }
  await chmod(join(staging, 'capsule', 'runtime', 'credential-launcher.sh'), 0o755)
  const built: BuiltCandidate = {
    candidateId: 'baseline',
    sourceDigest: admission.receipt.candidateDigest,
    capsuleDigest: admission.receipt.capsuleDigest,
    buildManifestDigest: digestV011(admission.receipt),
    sourceRoot: join(root, 'tree'),
    evidenceRefs: [],
    capsuleRoot: join(root, 'capsule'),
    runtimePackageName: admission.buildReceipt.runtimePackageName,
  }
  await writeFile(
    join(staging, 'admission-receipt.json'),
    canonicalV011(admission.receipt) + '\n',
    { mode: 0o600 },
  )
  await writeFile(join(staging, 'stable-build.json'), JSON.stringify(built, null, 2) + '\n', {
    mode: 0o600,
  })
  await mkdir(dirname(root), { recursive: true, mode: 0o700 })
  await rename(staging, root)
  return built
}

async function prepareProposalBaseRuntime(config: V011DemoConfig): Promise<string> {
  const root = join(config.stateDir, 'trusted-runtime', 'v011-proposer-base')
  if ((await stat(join(root, 'node')).catch(() => null))?.isFile()) return root
  const staging = await mkdtemp(join(config.stateDir, '.v011-proposer-base-'))
  try {
    const baselineRoot = join(config.repoRoot, 'packages', 'candidate-baseline')
    const receipt = await buildCandidate({
      sourceRoot: baselineRoot,
      sourceFiles: V1_SOURCE_FILES,
      tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
    })
    const capsule = join(staging, 'capsule')
    const dsh = join(config.repoRoot, 'deepseek-harness')
    const { packCapsule } = await import('@dsh-rsi/candidate-sdk')
    await packCapsule({
      outDir: capsule,
      receipt,
      runnerOverlay: '\n',
      provenanceJson: '{}',
      sbomJson: '{}',
      runtimeClosure: {
        catalogRoots: [
          join(config.repoRoot, 'packages'),
          join(dsh, 'packages'),
          join(dsh, 'vendor'),
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
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    await cp(join(capsule, 'runtime'), root, { recursive: true, errorOnExist: true })
    return root
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function exportForProposal(
  config: V011DemoConfig,
  generation: number,
  attempt: number,
): Promise<{
  root: string
  manifest: Awaited<ReturnType<typeof materializeProposerExport>>
  refs: ObjectRef[]
}> {
  const store: ObjectStore = { root: join(config.stateDir, 'v011', 'object-store') }
  const refs = await collectEvidence(config, store)
  if (refs.length === 0) throw new Error('v0.1.1 proposer: no raw development evidence available')
  const actionId = `proposal-${generation}-${attempt}`
  const root = join(config.stateDir, 'v011', 'exports', actionId)
  const existing = await readFile(join(root, 'manifest.json'), 'utf8').catch(() => null)
  if (existing !== null) {
    const manifest = JSON.parse(existing) as Awaited<ReturnType<typeof materializeProposerExport>>
    const included = new Set(manifest.objects.map((object) => object.digest))
    return { root, manifest, refs: refs.filter((ref) => included.has(ref.digest)) }
  }
  const status = await readControllerStatus(config as never)
  const manifest = await materializeProposerExport({
    store,
    outDir: root,
    exportId: `v011-${config.runId}-${actionId}`,
    principal: `proposer:${actionId}`,
    objects: refs,
    createdFromStateHash: status.stateHash,
  })
  return { root, manifest, refs }
}

async function realV011Proposal(
  config: V011DemoConfig,
  catalog: FrozenCapabilityCatalog,
  input: StableProposalInput,
): Promise<StableProposal> {
  const action = join(
    config.stateDir,
    'v011',
    'actions',
    `proposal-${input.generation}-${input.attempt}`,
  )
  const cache = join(action, 'materialization.json')
  const existing = await readFile(cache, 'utf8').catch(() => null)
  if (existing !== null)
    return (JSON.parse(existing) as { stableProposal: StableProposal }).stableProposal
  if (input.generation === 1 && input.attempt === 1) {
    await mkdir(action, { recursive: true, mode: 0o700 })
    const fixturePath = join(action, 'rejection.json')
    if ((await stat(fixturePath).catch(() => null)) === null) {
      await writeExclusive(
        fixturePath,
        JSON.stringify({
          schemaVersion: 1,
          classification: 'UNDECLARED_OUTPUT_FIXTURE',
          retained: true,
        }) + '\n',
      )
    }
    throw new Error('v0.1.1 deterministic rejection fixture: undeclared output')
  }
  const exported = await exportForProposal(config, input.generation, input.attempt)
  const exportDigest = digestV011(canonicalV011(exported.manifest))
  const proposalId = reserveProposalId({
    runId: config.runId,
    generation: input.generation,
    attempt: input.attempt,
    parentDigest: input.parent.sourceDigest,
    exportManifestDigest: exportDigest,
    capabilityCatalogDigest: catalog.digest,
  })
  const parentInput = join(action, 'input', 'parent')
  const archiveInput = join(action, 'input', 'archive')
  const contractsInput = join(action, 'input', 'contracts')
  const childrenRoot = join(action, 'children')
  const slot = join(childrenRoot, proposalId)
  if ((await stat(slot).catch(() => null)) === null) {
    await mkdir(parentInput, { recursive: true, mode: 0o700 })
    await cp(input.parent.sourceRoot, join(parentInput, 'tree'), { recursive: true })
    await mkdir(archiveInput, { recursive: true, mode: 0o700 })
    await writeFile(
      join(archiveInput, 'catalog.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          sourceLabel: 'DEV_OBSERVED',
          parent: input.parent.candidateId,
          generation: input.generation,
          rejectionEvidence: input.evidenceRefs.filter((ref) => ref.startsWith('rejection:')),
        },
        null,
        2,
      ) + '\n',
    )
    await mkdir(join(contractsInput, 'schemas'), { recursive: true, mode: 0o700 })
    for (const schema of SCHEMAS)
      await cp(join(config.repoRoot, 'schemas', schema), join(contractsInput, 'schemas', schema))
    await cp(join(config.repoRoot, 'docs', 'v0.1.1.md'), join(contractsInput, 'v0.1.1.md'))
    await writeFile(
      join(contractsInput, 'capability-catalog.json'),
      JSON.stringify(catalog, null, 2) + '\n',
    )
    await mkdir(childrenRoot, { recursive: true, mode: 0o700 })
    await mkdir(slot, { recursive: true, mode: 0o700 })
    await materializeV011ChildSlot(input.parent.sourceRoot, join(slot, 'tree'))
  }
  const workerOutput = join(slot, 'worker-output.json')
  if ((await stat(workerOutput).catch(() => null)) === null) {
    if (input.parent.capsuleRoot === undefined || input.parent.runtimePackageName === undefined) {
      throw new Error('v0.1.1 proposer: parent capsule runtime identity missing')
    }
    const baseRuntime = await prepareProposalBaseRuntime(config)
    const runtimeRoot = join(action, 'runtime')
    if ((await stat(runtimeRoot).catch(() => null)) === null)
      await cp(baseRuntime, runtimeRoot, { recursive: true })
    const selectedRuntime = join(runtimeRoot, 'selected-parent')
    const selectedEntry = join(
      input.parent.capsuleRoot,
      'runtime',
      'node_modules',
      ...input.parent.runtimePackageName.split('/'),
      'lib',
      'index.js',
    )
    const runtimeEntry = join(selectedRuntime, 'index.js')
    const expectedParentRuntimeDigest = await treeDigest(dirname(selectedEntry))
    if ((await stat(runtimeEntry).catch(() => null)) === null) {
      await cp(dirname(selectedEntry), selectedRuntime, { recursive: true })
    }
    const parentEntryDigest = sha(await readFile(runtimeEntry))
    const parentRuntimeDigest = await treeDigest(selectedRuntime)
    if (parentRuntimeDigest !== expectedParentRuntimeDigest) {
      throw new Error('v0.1.1 proposer: incomplete or conflicting selected-parent runtime')
    }
    const route = await loadTrustedRoute()
    const lockedRoute: ProposalGatewayRoute = {
      provider: 'deepseek',
      endpoint: route.baseUrl,
      model: config.model.requested,
      reasoningEffort: config.model.reasoningEffort,
      maxTokens: config.model.maxOutputTokens,
    }
    await writeFile(
      join(contractsInput, 'request.json'),
      JSON.stringify({
        route: lockedRoute,
        proposalId,
        parentDigest: input.parent.sourceDigest,
        parentEntryDigest,
        parentRuntimeDigest,
        candidateId: input.parent.candidateId,
        exportManifestDigest: exportDigest,
        exportMerkleRoot: exported.manifest.merkleRoot,
        capabilityCatalogDigest: catalog.digest,
        ancestorClusters:
          input.parent.targetClusterSlug === undefined ? [] : [input.parent.targetClusterSlug],
      }) + '\n',
      { mode: 0o600 },
    )
    const previousKey = process.env['RSI_PROVIDER_API_KEY']
    process.env['RSI_PROVIDER_API_KEY'] = route.apiKey
    const adapter = new TrustedChatCompletionsAdapter({
      route: lockedRoute,
      apiKeyEnv: 'RSI_PROVIDER_API_KEY',
      expectedResponseModel: config.model.effective,
      contextWindow: config.model.contextWindow,
      requestMaxRetries: 12,
      reasoningContinuationMaxTurns: 1,
    })
    let providerFailure: string | null = null
    const handler = createProposalGatewayLlmHandler(adapter, lockedRoute)
    const gateway = await startProposalGateway({
      socketPath: join(action, 'gateway', 'proposal.sock'),
      route: lockedRoute,
      async handle(payload) {
        try {
          return await handler(payload)
        } catch (error) {
          providerFailure = error instanceof Error ? error.message : 'unknown provider failure'
          throw error
        }
      },
    })
    let sandboxResult:
      { exitCode: number | null; signal: string | null; stderr: string } | undefined
    try {
      const result = await runProposalSandbox({
        mounts: {
          parent: parentInput,
          archive: archiveInput,
          evidence: exported.root,
          contracts: contractsInput,
          childrenRoot,
        },
        runtimeRoot,
        command: '/runtime/node',
        args: ['/runtime/node_modules/@dsh-rsi/proposer/lib/v011-sandbox-worker.js'],
        timeoutMs: 1_800_000,
        maxOutputBytes: 4 * 1024 * 1024,
        gatewaySocket: gateway.socketPath,
      })
      sandboxResult = result
      if (result.exitCode !== 0) throw new Error(`v0.1.1 real proposer failed: ${result.stderr}`)
    } finally {
      await writeExclusive(
        join(action, 'gateway-receipts.json'),
        JSON.stringify(gateway.receipts(), null, 2) + '\n',
      )
      await writeExclusive(
        join(action, 'proposal-diagnostic.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            providerFailure,
            gatewayReceiptCount: gateway.receipts().length,
            sandbox:
              sandboxResult === undefined
                ? null
                : {
                    exitCode: sandboxResult.exitCode,
                    signal: sandboxResult.signal,
                    stderrSha256: sha(sandboxResult.stderr),
                  },
          },
          null,
          2,
        ) + '\n',
      )
      await gateway.close()
      if (previousKey === undefined) delete process.env['RSI_PROVIDER_API_KEY']
      else process.env['RSI_PROVIDER_API_KEY'] = previousKey
    }
  }
  const worker = JSON.parse(await readFile(workerOutput, 'utf8')) as {
    transcript: { assistantText: string; toolTrace: unknown[]; eventCount: number }
    toolCallCount: number
  }
  const store: ObjectStore = { root: join(config.stateDir, 'v011', 'object-store') }
  const materialized = await materializeV011Proposal({
    store,
    parentRoot: input.parent.sourceRoot,
    childRoot: join(slot, 'tree'),
    exportRoot: exported.root,
    exportManifest: exported.manifest,
    expected: {
      proposalId,
      parentDigest: input.parent.sourceDigest as `sha256:${string}`,
      exportManifestDigest: exportDigest,
      exportMerkleRoot: exported.manifest.merkleRoot as `sha256:${string}`,
    },
    capabilityCatalog: catalog,
    transcript: Buffer.from(worker.transcript.assistantText),
    toolTrace: Buffer.from(JSON.stringify(worker.transcript.toolTrace)),
    proposerUsage: {
      gatewayReceipts: JSON.parse(await readFile(join(action, 'gateway-receipts.json'), 'utf8'))
        .length,
      eventCount: worker.transcript.eventCount,
    },
    ancestorClustersRequiringReconciliation:
      input.parent.targetClusterSlug === undefined ? [] : [input.parent.targetClusterSlug],
  })
  const analysis = JSON.parse(await readFile(join(slot, 'analysis.json'), 'utf8')) as {
    falsifiableHypothesis: string
  }
  const stableProposal: StableProposal = {
    proposalId,
    parentCandidateId: input.parent.candidateId,
    hypothesis: analysis.falsifiableHypothesis,
    sourceDiff: JSON.stringify({ slot, operations: materialized.receipt.operations }),
    evidenceRefs: exported.refs.map((ref) => `object:sha256:${ref.digest}`),
    artifactDigest: `sha256:${materialized.receiptRef.digest}`,
  }
  await writeExclusive(
    cache,
    JSON.stringify({ stableProposal, materialization: materialized.receipt }, null, 2) + '\n',
  )
  return stableProposal
}

async function realV011Build(
  config: V011DemoConfig,
  catalog: FrozenCapabilityCatalog,
  baseUrl: string,
  input: StableBuildInput,
): Promise<BuiltCandidate> {
  const root = join(config.stateDir, 'candidates', `generation-${input.generation}`)
  const record = await readFile(join(root, 'stable-build.json'), 'utf8').catch(() => null)
  if (record !== null) return JSON.parse(record) as BuiltCandidate
  if ((await stat(root).catch(() => null)) !== null)
    throw new Error('v0.1.1 builder: incomplete candidate directory')
  const parsed = JSON.parse(input.proposal.sourceDiff) as { slot?: unknown }
  if (typeof parsed.slot !== 'string')
    throw new Error('v0.1.1 builder: proposal slot binding missing')
  const staging = `${root}.attempt-${input.attempt}.staging`
  if ((await stat(staging).catch(() => null)) !== null)
    throw new Error('v0.1.1 builder: incomplete staging exists')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  await cp(join(parsed.slot, 'tree'), join(staging, 'tree'), { recursive: true })
  const admission = await admitV011Candidate({
    sourceRoot: join(staging, 'tree'),
    toolchainRoot: config.repoRoot,
    tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
    materializationDigest: input.proposal.artifactDigest as `sha256:${string}`,
    capabilityCatalogDigest: catalog.digest,
    capsuleOutDir: join(staging, 'capsule'),
    runtimeClosure: solverRuntime(config),
    runnerOverlay: solverOverlay(config, baseUrl),
    runnerFiles: { 'credential-launcher.sh': credentialLauncher },
    provenanceJson: JSON.stringify({ protocol: V011_PROTOCOL, model: config.model }),
    sbomJson: JSON.stringify({ spdxVersion: 'SPDX-2.3' }),
  })
  if (admission.buildReceipt.runtimePackageName === undefined) {
    throw new Error('v0.1.1 builder: runtime package identity missing')
  }
  await chmod(join(staging, 'capsule', 'runtime', 'credential-launcher.sh'), 0o755)
  const materialization = JSON.parse(
    await readFile(
      join(
        config.stateDir,
        'v011',
        'actions',
        `proposal-${input.generation}-${input.attempt}`,
        'materialization.json',
      ),
      'utf8',
    ),
  ) as { materialization: { proposalDigest: string; analysisDigest: string } }
  const analysis = JSON.parse(await readFile(join(parsed.slot, 'analysis.json'), 'utf8')) as {
    selectedCluster: string
  }
  const built: BuiltCandidate = {
    candidateId: admission.receipt.candidateDigest,
    sourceDigest: admission.receipt.candidateDigest,
    capsuleDigest: admission.receipt.capsuleDigest,
    buildManifestDigest: digestV011(admission.receipt),
    sourceRoot: join(root, 'tree'),
    evidenceRefs: input.proposal.evidenceRefs,
    capsuleRoot: join(root, 'capsule'),
    runtimePackageName: admission.buildReceipt.runtimePackageName,
    proposalDigest: materialization.materialization.proposalDigest,
    analysisDigest: materialization.materialization.analysisDigest,
    targetClusterSlug: analysis.selectedCluster,
    hypothesis: input.proposal.hypothesis,
  }
  await writeFile(
    join(staging, 'admission-receipt.json'),
    canonicalV011(admission.receipt) + '\n',
    { mode: 0o600 },
  )
  await writeFile(join(staging, 'stable-build.json'), JSON.stringify(built, null, 2) + '\n', {
    mode: 0o600,
  })
  await mkdir(dirname(root), { recursive: true, mode: 0o700 })
  await rename(staging, root)
  return built
}

async function observedTaskIds(config: V011DemoConfig): Promise<string[]> {
  const [split, inventory] = (await Promise.all([
    readFile(config.splitCommitmentPath, 'utf8').then((raw) => JSON.parse(raw)),
    readFile(config.inventoryPath, 'utf8').then((raw) => JSON.parse(raw)),
  ])) as [{ observedTaskIds?: unknown }, { tasks?: unknown }]
  if (!Array.isArray(split.observedTaskIds) || !Array.isArray(inventory.tasks)) {
    throw new Error('v0.1.1 capabilities: split/inventory invalid')
  }
  return selectFailureSeekingObservedTasks(
    split.observedTaskIds as string[],
    inventory.tasks as Array<{
      taskId: string
      agentTimeoutSec: number
      difficulty: 'easy' | 'medium' | 'hard'
    }>,
  )
}

export async function createV011RealCapabilities(
  config: V011DemoConfig,
): Promise<StableDemoCapabilities> {
  const route = await loadTrustedRoute()
  const catalog = await capabilityCatalog(config)
  const baseline = await prepareBaseline(config, catalog, route.baseUrl)
  return {
    preflight: () => runDoctor(config as never),
    baseline,
    observedTaskIds: () => observedTaskIds(config),
    propose: (input) => realV011Proposal(config, catalog, input),
    build: (input) => realV011Build(config, catalog, route.baseUrl, input),
    evaluationProvider: (spec) => createRealEvaluationProvider(config as never, spec),
    reserveUsd: () => config.limits.budgetUsd / 15,
    async afterCandidateEvaluation(input) {
      if (
        input.child.proposalDigest === undefined ||
        input.child.targetClusterSlug === undefined ||
        input.child.hypothesis === undefined
      ) {
        throw new Error('v0.1.1 outcome: child proposal binding missing')
      }
      const baselineObservation = input.observations.find(
        (row) => row.candidateId === 'baseline' && row.taskId === input.taskId,
      )
      const childObservation = input.observations.find(
        (row) => row.candidateId === input.child.candidateId && row.taskId === input.taskId,
      )
      if (baselineObservation === undefined || childObservation === undefined) {
        throw new Error('v0.1.1 outcome: target observation pair incomplete')
      }
      const outcomePath = join(
        config.stateDir,
        'v011',
        'outcomes',
        `generation-${input.generation}`,
        'outcome.json',
      )
      const result = await recoverV011OutcomeDerivation({
        path: outcomePath,
        proposalDigest: input.child.proposalDigest as `sha256:${string}`,
        hypothesis: input.child.hypothesis,
        candidateDigest: input.child.candidateId as `sha256:${string}`,
        targetClusterSlug: input.child.targetClusterSlug,
        targetTaskHandle: input.taskId,
        trials: [
          {
            ref: digestV011(baselineObservation),
            role: 'target-baseline',
            status: baselineObservation.status,
            reward: baselineObservation.reward as 0 | 1 | null,
          },
          {
            ref: digestV011(childObservation),
            role: 'target-child',
            status: childObservation.status,
            reward: childObservation.reward as 0 | 1 | null,
          },
        ],
      })
      const store: ObjectStore = { root: join(config.stateDir, 'v011', 'object-store') }
      const ref = await publishBytes(
        store,
        Buffer.from(canonicalV011(result.record)),
        'application/vnd.dsh-rsi.mechanism-outcome+json',
        'DEV_OBSERVED',
      )
      return { outcomeDigest: `sha256:${ref.digest}`, status: result.record.status }
    },
  }
}
