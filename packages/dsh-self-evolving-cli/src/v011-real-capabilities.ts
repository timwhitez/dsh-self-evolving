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
  v011SchemaDigest,
  freezeCapabilityCatalog,
  materializeV011ChildSlot,
  reserveProposalId,
  snapshotV011Tree,
  V011_PROTOCOL,
  type FrozenCapabilityCatalog,
} from '@dsh-self-evolving/candidate-sdk'
import {
  materializeProposerExport,
  materializeV011Proposal,
  publishBytes,
  readControllerStatus,
  recoverV011OutcomeDerivation,
  runProposalSandbox,
  type ObjectRef,
  type ObjectStore,
  type V011ParentEvidenceBinding,
} from '@dsh-self-evolving/core'
import {
  TrustedResponsesAdapter,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayRoute,
} from '@dsh-self-evolving/proposer'
import { claimStagingDir } from './build-claim.js'
import type { V011DemoConfig } from './config.js'
import type {
  BuiltCandidate,
  StableBuildInput,
  StableDemoCapabilities,
  StableProposal,
  StableProposalInput,
} from './engine.js'
import { evaluationReserveUsd } from './engine.js'
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

function diagnosticTail(message: string, maxBytes = 8192): string {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  const clean = message.replace(ansiColor, '')
  if (Buffer.byteLength(clean) <= maxBytes) return clean
  let low = 0
  let high = clean.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (Buffer.byteLength(clean.slice(middle)) > maxBytes) low = middle + 1
    else high = middle
  }
  if (low < clean.length && /[\uDC00-\uDFFF]/.test(clean[low]!)) low += 1
  return clean.slice(low)
}

/** Publish idempotently: existing identical bytes are reused, any conflict fails. */
async function writeIdempotent(path: string, bytes: string, mode = 0o600): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing === bytes) return
  if (existing !== null) {
    throw new Error(`v0.1.1 fixture: conflicting retained artifact at ${path}`)
  }
  await writeExclusive(path, bytes, mode)
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

async function retainProposalRejection(
  action: string,
  classification: 'PROPOSAL_SANDBOX_REJECT' | 'PROPOSAL_SEMANTIC_REJECT',
  message: string,
): Promise<void> {
  const path = join(action, 'rejection.json')
  if ((await stat(path).catch(() => null)) !== null) return
  await writeExclusive(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        classification,
        reason: diagnosticTail(message),
        reasonDigest: sha(message),
        retained: true,
      },
      null,
      2,
    ) + '\n',
  )
}

export async function retainV011BuildRejection(input: {
  stateDir: string
  generation: number
  attempt: number
  proposalId: string
  message: string
}): Promise<string> {
  const path = join(
    input.stateDir,
    'v011',
    'actions',
    `proposal-${input.generation}-${input.attempt}`,
    'build',
    'rejection.json',
  )
  const bytes =
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: 'BUILD_REJECT',
        proposalId: input.proposalId,
        reason: diagnosticTail(input.message),
        reasonDigest: sha(input.message),
        retained: true,
      },
      null,
      2,
    ) + '\n'
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing === null) await writeExclusive(path, bytes)
  else if (existing !== bytes) throw new Error('v0.1.1 build rejection: conflicting evidence')
  return path
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
  if (name === 'trajectory.json') return 'application/vnd.dsh-self-evolving.atif+json'
  if (name === 'summary.json')
    return 'application/vnd.dsh-self-evolving.normalized-trial-record+json'
  if (name === 'acp-events.jsonl') return 'application/vnd.dsh-self-evolving.acp-events+jsonl'
  if (name === 'acp-summary.json') return 'application/vnd.dsh-self-evolving.acp-summary+json'
  if (name === 'session.jsonl') return 'application/vnd.dsh-self-evolving.dsh-session+jsonl'
  if (name === 'analysis.json') return 'application/vnd.dsh-self-evolving.analysis+json'
  if (name === 'outcome.json') return 'application/vnd.dsh-self-evolving.mechanism-outcome+json'
  if (name === 'rejection.json') return 'application/vnd.dsh-self-evolving.rejection+json'
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

function solverOverlay(config: V011DemoConfig): string {
  return [
    '- id: deepseek-responses',
    "  name: '@dsh-self-evolving/llm-responses'",
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    '    reasoningEffort: high',
    `    maxTokens: ${config.model.maxOutputTokens}`,
    `    defaultContextWindow: ${config.model.contextWindow}`,
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
    "    persona: 'dsh-self-evolving candidate. Solve autonomously with bounded tools and verify the task result.'",
    '- id: self-evolving-candidate',
    "  name: '__DSH_SELF_EVOLVING_RUNTIME_PACKAGE__'",
    '  config:',
    '    candidateId: __DSH_SELF_EVOLVING_CANDIDATE_ID__',
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
      '@dsh-self-evolving/llm-responses',
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
  'secret_file=${DSH_SELF_EVOLVING_PROVIDER_SECRET_FILE:-/run/dsh-self-evolving/provider.secret}',
  'test -f "$secret_file"',
  'DEEPSEEK_API_KEY=$(cat -- "$secret_file")',
  'test -n "$DEEPSEEK_API_KEY"',
  'export DEEPSEEK_API_KEY',
  'unset DSH_SELF_EVOLVING_PROVIDER_SECRET_FILE',
  'exec "$runtime/dsh-self-evolving-acp" "$@"',
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
    runnerOverlay: solverOverlay(config),
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
    const { packCapsule } = await import('@dsh-self-evolving/candidate-sdk')
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
          '@dsh-self-evolving/proposer',
          '@deepseek-ai/dsh-agent-spine-demo',
          '@deepseek-ai/dsh-agent-default-model',
          '@deepseek-ai/cordis-plugin-loader',
        ],
        entryPackage: '@dsh-self-evolving/proposer',
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

async function exactParentEvidenceBinding(
  config: V011DemoConfig,
  input: StableProposalInput,
  manifest: Awaited<ReturnType<typeof materializeProposerExport>>,
): Promise<V011ParentEvidenceBinding | undefined> {
  if (input.generation === 1) return undefined
  if (input.parent.analysisDigest === undefined) {
    throw new Error('v0.1.1 parent evidence: parent analysis digest missing')
  }
  const parentGeneration = input.generation - 1
  const actionId = `eval:candidate:${parentGeneration}`
  const status = await readControllerStatus(config as never)
  const action = status.state.actions[actionId]
  if (action?.status !== 'COMMITTED' || action.externalJobId === null) {
    throw new Error('v0.1.1 parent evidence: parent evaluation is not committed')
  }
  const summaryBytes = await readFile(
    join(config.stateDir, 'external-evaluator', action.externalJobId, 'summary.json'),
  )
  const summary = JSON.parse(summaryBytes.toString('utf8')) as {
    runId?: unknown
    normalized?: Array<{ trajectoryHash?: unknown }>
  }
  const trajectoryHash = summary.normalized?.[0]?.trajectoryHash
  if (
    summary.runId !== action.externalJobId ||
    typeof trajectoryHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(trajectoryHash)
  ) {
    throw new Error('v0.1.1 parent evidence: normalized parent trial binding invalid')
  }
  const outcomeBytes = await readFile(
    join(config.stateDir, 'v011', 'outcomes', `generation-${parentGeneration}`, 'outcome.json'),
  )
  const outcome = JSON.parse(outcomeBytes.toString('utf8')) as { candidateDigest?: unknown }
  if (outcome.candidateDigest !== input.parent.candidateId) {
    throw new Error('v0.1.1 parent evidence: mechanism outcome candidate mismatch')
  }
  const binding: V011ParentEvidenceBinding = {
    schemaVersion: 1,
    parentCandidateDigest: input.parent.candidateId as `sha256:${string}`,
    parentEvaluationActionId: actionId,
    parentExternalJobId: action.externalJobId,
    analysisDigest: input.parent.analysisDigest as `sha256:${string}`,
    mechanismOutcomeDigest: sha(outcomeBytes),
    normalizedTrialDigest: sha(summaryBytes),
    trajectoryDigest: `sha256:${trajectoryHash}`,
  }
  const exported = new Map(
    manifest.objects.map((object) => [`sha256:${object.digest}`, object.mediaType]),
  )
  const expected = [
    [binding.analysisDigest, /analysis/i],
    [binding.mechanismOutcomeDigest, /mechanism-outcome/i],
    [binding.normalizedTrialDigest, /normalized|trial-record/i],
    [binding.trajectoryDigest, /atif|trajectory/i],
  ] as const
  for (const [digest, media] of expected) {
    if (!media.test(exported.get(digest) ?? '')) {
      throw new Error(`v0.1.1 parent evidence: ${digest} absent from exact export`)
    }
  }
  return binding
}

/**
 * Execute the deterministic invalid-replacement fixture through the real
 * validator and persist its complete lifecycle. The analysis is
 * intentionally schema-invalid so assertV011 rejects it; the rejection
 * record binds the validator, both fixture digests (the proposal is
 * retained for attribution, only the analysis is replayed) and the reason
 * digest so the audit can reproduce the rejection independently.
 */
async function executeInvalidReplacementFixture(
  action: string,
  binding: {
    runId: string
    proposalId: string
    parentDigest: string
    exportManifestDigest: `sha256:${string}`
  },
): Promise<void> {
  const fixturePath = join(action, 'rejection.json')
  if ((await stat(fixturePath).catch(() => null)) !== null) return
  await mkdir(action, { recursive: true, mode: 0o700 })
  const fixtureProposal = {
    schemaVersion: 2,
    proposalId: binding.proposalId,
    canonicalParentDigest: binding.parentDigest,
    evidenceExport: { manifestDigest: binding.exportManifestDigest },
  }
  // Schema-invalid on purpose on four independent counts (missing
  // preservationRequirements, empty failureClusters/regressionRisks,
  // too-short falsifiableHypothesis) so accidental validity requires
  // loosening the schema itself.
  const fixtureAnalysis = {
    schemaVersion: 1,
    failureClusters: [],
    ancestorReconciliations: [],
    selectedCluster: 'fixture-invalid-cluster',
    falsifiableHypothesis: 'fixture hypothesis',
    expectedBehaviorChange: 'none',
    regressionRisks: [],
  }
  let reason: string | null = null
  try {
    await assertV011('analysis', fixtureAnalysis)
  } catch (error) {
    reason = error instanceof Error ? error.message : 'unknown fixture rejection'
  }
  if (reason === null) {
    // Fail loud OUTSIDE the try: a swallowed sentinel would become
    // synthesized evidence wearing the real-record shape.
    throw new Error('v0.1.1 fixture: invalid analysis unexpectedly validated')
  }
  const proposalBytes = JSON.stringify(fixtureProposal, null, 2) + '\n'
  const analysisBytes = JSON.stringify(fixtureAnalysis, null, 2) + '\n'
  await writeIdempotent(join(action, 'invalid-fixture-proposal.json'), proposalBytes)
  await writeIdempotent(join(action, 'invalid-fixture-analysis.json'), analysisBytes)
  await writeExclusive(
    fixturePath,
    JSON.stringify(
      {
        schemaVersion: 2,
        classification: 'FIXTURE_VALIDATOR_REJECT',
        validator: 'assertV011:analysis',
        analysisSchemaDigest: await v011SchemaDigest('analysis'),
        fixtureProposalDigest: digestV011(proposalBytes),
        fixtureAnalysisDigest: digestV011(analysisBytes),
        reasonDigest: sha(reason),
        reason: diagnosticTail(reason),
        binding,
        retained: true,
        replacedBy: `${binding.runId}/proposal/1/1`,
      },
      null,
      2,
    ) + '\n',
  )
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
  const exported = await exportForProposal(config, input.generation, input.attempt)
  const requiredParentEvidence = await exactParentEvidenceBinding(config, input, exported.manifest)
  const exportDigest = digestV011(canonicalV011(exported.manifest))
  const proposalId = reserveProposalId({
    runId: config.runId,
    generation: input.generation,
    attempt: input.attempt,
    parentDigest: input.parent.sourceDigest,
    exportManifestDigest: exportDigest,
    capabilityCatalogDigest: catalog.digest,
  })
  if (input.generation === 1 && input.attempt === 1) {
    // The "deterministic invalid-child replacement" fixture must be a REAL
    // negative action: a retained invalid proposal/analysis pair pushed
    // through the same trusted validators, with the rejection record binding
    // the validator identity, the exact fixture digests and the failure
    // reason digest — never a free-standing synthesized file (issue #113).
    await executeInvalidReplacementFixture(action, {
      runId: config.runId,
      proposalId,
      parentDigest: input.parent.sourceDigest,
      exportManifestDigest: exportDigest,
    })
  }
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
    if (requiredParentEvidence !== undefined) {
      await writeFile(
        join(contractsInput, 'parent-evidence-binding.json'),
        JSON.stringify(requiredParentEvidence, null, 2) + '\n',
        { mode: 0o600 },
      )
    }
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
    const sandboxTimeoutMs = 1_800_000
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
        llmDeadlineMs: Math.max(60_000, sandboxTimeoutMs - 120_000),
        parentDigest: input.parent.sourceDigest,
        parentEntryDigest,
        parentRuntimeDigest,
        candidateId: input.parent.candidateId,
        exportManifestDigest: exportDigest,
        exportMerkleRoot: exported.manifest.merkleRoot,
        capabilityCatalogDigest: catalog.digest,
        ancestorClusters:
          input.parent.targetClusterSlug === undefined ? [] : [input.parent.targetClusterSlug],
        ...(requiredParentEvidence === undefined ? {} : { requiredParentEvidence }),
      }) + '\n',
      { mode: 0o600 },
    )
    const previousKey = process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']
    process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = route.apiKey
    // Outer acquisition boundary: EVERY exit path from here restores the
    // previous environment and closes the gateway, aggregating cleanup
    // failures instead of letting an evidence-write EEXIST strand a live
    // socket or a process-global credential (issue #118).
    let gateway: Awaited<ReturnType<typeof startProposalGateway>> | undefined
    let providerFailure: string | null = null
    const sandboxResultRef: {
      value: { exitCode: number | null; signal: string | null; stderr: string } | undefined
    } = { value: undefined }
    const cleanupErrors: unknown[] = []
    const bodyErrorRef: { value?: unknown } = {}
    try {
      const adapter = new TrustedResponsesAdapter({
        route: lockedRoute,
        apiKeyEnv: 'DSH_SELF_EVOLVING_PROVIDER_API_KEY',
        expectedResponseModel: config.model.effective,
        contextWindow: config.model.contextWindow,
        requestMaxRetries: 12,
        reasoningContinuationMaxTurns: 1,
      })
      const handler = createProposalGatewayLlmHandler(adapter, lockedRoute)
      gateway = await startProposalGateway({
        socketPath: join(action, 'gateway', 'proposal.sock'),
        route: lockedRoute,
        requestTimeoutMs: sandboxTimeoutMs,
        // `action` is the durable per-action directory: request results
        // survive restarts and replays instead of re-billing (issue #56).
        stateDir: join(action, 'gateway', 'requests'),
        async handle(payload, context) {
          try {
            return await handler(payload, context)
          } catch (error) {
            providerFailure = error instanceof Error ? error.message : 'unknown provider failure'
            throw error
          }
        },
      })
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
        args: ['/runtime/node_modules/@dsh-self-evolving/proposer/lib/v011-sandbox-worker.js'],
        timeoutMs: sandboxTimeoutMs,
        maxOutputBytes: 4 * 1024 * 1024,
        gatewaySocket: gateway.socketPath,
      })
      sandboxResultRef.value = {
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
      }
      if (result.exitCode !== 0) {
        const message = `v0.1.1 real proposer failed: ${result.stderr}`
        await retainProposalRejection(action, 'PROPOSAL_SANDBOX_REJECT', message)
        throw new Error(message)
      }
    } catch (error) {
      bodyErrorRef.value = error
    } finally {
      // Teardown first so the trusted socket never outlives the work; receipt
      // publication happens independently afterwards.
      if (gateway !== undefined) {
        await gateway.close().catch((error) => cleanupErrors.push(error))
      }
      const receiptsBytes = JSON.stringify(gateway?.receipts() ?? [], null, 2) + '\n'
      await writeExclusive(join(action, 'gateway-receipts.json'), receiptsBytes).catch((error) =>
        cleanupErrors.push(error),
      )
      await writeExclusive(
        join(action, 'proposal-diagnostic.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            providerFailure,
            gatewayReceiptCount: gateway?.receipts().length ?? 0,
            sandbox:
              sandboxResultRef.value === undefined
                ? null
                : {
                    exitCode: sandboxResultRef.value.exitCode,
                    signal: sandboxResultRef.value.signal,
                    stderrSha256: sha(sandboxResultRef.value.stderr),
                    stderrTail: diagnosticTail(sandboxResultRef.value.stderr),
                  },
          },
          null,
          2,
        ) + '\n',
      ).catch((error) => cleanupErrors.push(error))
      if (previousKey === undefined) delete process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']
      else process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = previousKey
    }
    // The original body error keeps priority; cleanup failures surface only
    // after the environment is restored and never mask it (issue #118).
    if (bodyErrorRef.value !== undefined) {
      throw bodyErrorRef.value
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0] instanceof Error
        ? cleanupErrors[0]
        : new Error(String(cleanupErrors[0]))
    }
  }
  const worker = JSON.parse(await readFile(workerOutput, 'utf8')) as {
    transcript: { assistantText: string; toolTrace: unknown[]; eventCount: number }
    toolCallCount: number
    finishedTreeDigest?: unknown
  }
  // The sandbox finish receipt is bound to the exact policy/test-validated
  // bytes; the trusted side must publish the SAME tree (issue #125): the
  // materializer recomputes the canonical archive hash, so compare domains
  // match and any drift fails closed here.
  if (
    typeof worker['finishedTreeDigest'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(worker['finishedTreeDigest'])
  ) {
    throw new Error('v0.1.1 proposal: worker output lacks a valid finished tree digest')
  }
  const store: ObjectStore = { root: join(config.stateDir, 'v011', 'object-store') }
  let materialized: Awaited<ReturnType<typeof materializeV011Proposal>>
  try {
    materialized = await materializeV011Proposal({
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
      ...(requiredParentEvidence === undefined ? {} : { requiredParentEvidence }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown semantic rejection'
    await retainProposalRejection(action, 'PROPOSAL_SEMANTIC_REJECT', message)
    throw error
  }
  // End-to-end binding: the published tree must be the exact bytes the
  // sandbox validated (policy scan + candidate tests run only sandbox-side;
  // this comparison is what carries their verdict into trusted publication).
  if (materialized.receipt.sourceDigest !== worker['finishedTreeDigest']) {
    throw new Error(
      'v0.1.1 proposal: materialized tree differs from the finished validation digest',
    )
  }
  // INVARIANT (issue #200): the finish digest binds only the child TREE; the
  // slot-level analysis/proposal metadata is safe to read here ONLY because
  // trusted materialization fully revalidated these bytes above. If that
  // revalidation is ever weakened, slot metadata must be folded into the
  // finish digest first.
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

async function realV011BuildUnretained(
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
  await claimStagingDir(
    staging,
    { attempt: input.attempt, identity: input.proposal.artifactDigest },
    async () => dirname(root),
  )
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
    runnerOverlay: solverOverlay(config),
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

async function realV011Build(
  config: V011DemoConfig,
  catalog: FrozenCapabilityCatalog,
  baseUrl: string,
  input: StableBuildInput,
): Promise<BuiltCandidate> {
  try {
    return await realV011BuildUnretained(config, catalog, baseUrl, input)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown build rejection'
    await retainV011BuildRejection({
      stateDir: config.stateDir,
      generation: input.generation,
      attempt: input.attempt,
      proposalId: input.proposal.proposalId,
      message,
    })
    throw error
  }
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
  const baseline = await prepareBaseline(config, catalog)
  return {
    preflight: () => runDoctor(config as never),
    baseline,
    observedTaskIds: () => observedTaskIds(config),
    propose: (input) => realV011Proposal(config, catalog, input),
    build: (input) => realV011Build(config, catalog, route.baseUrl, input),
    evaluationProvider: (spec) => createRealEvaluationProvider(config as never, spec),
    reserveUsd: () => evaluationReserveUsd(config.limits.budgetUsd, config.limits.solverTrialsMax),
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
            taskId: baselineObservation.taskId,
            attemptIndex: baselineObservation.attemptIndex,
          },
          {
            ref: digestV011(childObservation),
            role: 'target-child',
            status: childObservation.status,
            reward: childObservation.reward as 0 | 1 | null,
            taskId: childObservation.taskId,
            attemptIndex: childObservation.attemptIndex,
          },
        ],
      })
      const store: ObjectStore = { root: join(config.stateDir, 'v011', 'object-store') }
      const ref = await publishBytes(
        store,
        Buffer.from(canonicalV011(result.record)),
        'application/vnd.dsh-self-evolving.mechanism-outcome+json',
        'DEV_OBSERVED',
      )
      return { outcomeDigest: `sha256:${ref.digest}`, status: result.record.status }
    },
  }
}
