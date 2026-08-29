import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  assertCompletedResourceDomainReceipt,
  buildCandidate,
  CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
  packCapsule,
  type ResourceDomainReceipt,
} from '@dsh-self-evolving/candidate-sdk'
import {
  atomicRenameWithDirSync,
  PROPOSAL_RESOURCE_POLICY_V1,
  PROPOSAL_WRITABLE_MOUNTS_V1,
  runProposalSandbox,
  type EvaluationObservation,
} from '@dsh-self-evolving/core'
import {
  TrustedResponsesAdapter,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayRoute,
} from '@dsh-self-evolving/proposer'
import { loadPublishedBundle, publishBundle } from './publish.js'
import { runDoctor } from './doctor.js'
import type { StableDemoConfig } from './config.js'
import type {
  BuiltCandidate,
  StableBuildInput,
  StableDemoCapabilities,
  StableEvaluationSpec,
  StableProposal,
  StableProposalInput,
} from './engine.js'
import { evaluationReserveUsd } from './engine.js'
import { claimStagingDir, clearBuildIntent, publishClaimedStagingDir } from './build-claim.js'
import { loadTrustedRoute } from './trusted-route.js'
import { GATE5_BROKER_PROTOCOL } from './gate5-security.js'

const SOURCE_FILES = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function exec(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ stdout: string; stderr: string }>((done, reject) => {
    execFile(
      file,
      args,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${basename(file)} failed: ${stderr}`, { cause: error }))
          : done({ stdout, stderr }),
    )
  })
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function assertBuildResourceEnvelope(
  value: unknown,
  candidateId?: string,
): {
  schemaVersion: 1
  candidateId?: string
  builds: [ResourceDomainReceipt, ResourceDomainReceipt]
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray((value as { builds?: unknown }).builds) ||
    (value as { builds: unknown[] }).builds.length !== 2
  ) {
    throw new Error('real resource receipt: invalid build envelope')
  }
  const record = value as Record<string, unknown>
  const expectedKeys =
    candidateId === undefined
      ? ['builds', 'schemaVersion']
      : ['builds', 'candidateId', 'schemaVersion']
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys) ||
    record['schemaVersion'] !== 1 ||
    (candidateId !== undefined && record['candidateId'] !== candidateId)
  ) {
    throw new Error('real resource receipt: build identity/envelope mismatch')
  }
  const builds = record['builds'] as unknown[]
  const verified = builds.map((receipt, index) =>
    assertCompletedResourceDomainReceipt(receipt, {
      policy: CANDIDATE_BUILD_RESOURCE_POLICY_V1,
      writableMounts: CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
      label: `real build resource[${index}]`,
    }),
  ) as [ResourceDomainReceipt, ResourceDomainReceipt]
  return {
    schemaVersion: 1,
    ...(candidateId === undefined ? {} : { candidateId }),
    builds: verified,
  }
}

export function assertProposalResourceReceipt(value: unknown): ResourceDomainReceipt {
  return assertCompletedResourceDomainReceipt(value, {
    policy: PROPOSAL_RESOURCE_POLICY_V1,
    writableMounts: PROPOSAL_WRITABLE_MOUNTS_V1,
    label: 'real proposal resource receipt',
  })
}

async function writeIdempotent(path: string, bytes: string): Promise<void> {
  const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing !== null) {
    if (existing !== bytes)
      throw new Error(`real proposer: conflicting retained evidence at ${path}`)
    return
  }
  try {
    await writeExclusive(path, bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if ((await readFile(path, 'utf8')) !== bytes) {
      throw new Error(`real proposer: conflicting retained evidence at ${path}`, { cause: error })
    }
  }
}

async function prepareProposalRuntime(config: StableDemoConfig): Promise<string> {
  const runtimeRoot = join(config.stateDir, 'trusted-runtime', 'proposer')
  const existingNode = (await stat(join(runtimeRoot, 'node')).catch(() => null))?.isFile() === true
  const existingReceipt =
    (await stat(join(runtimeRoot, 'build-resource.json')).catch(() => null))?.isFile() === true
  if (existingNode && existingReceipt) {
    assertBuildResourceEnvelope(
      JSON.parse(await readFile(join(runtimeRoot, 'build-resource.json'), 'utf8')) as unknown,
    )
    return runtimeRoot
  }
  if (existingNode || existingReceipt) {
    throw new Error('real proposer runtime: incomplete resource-bound publication')
  }
  const staging = await mkdtemp(join(config.stateDir, '.proposer-runtime-'))
  try {
    const baselineRoot = join(config.repoRoot, 'packages', 'candidate-baseline')
    const receipt = await buildCandidate({
      sourceRoot: baselineRoot,
      sourceFiles: SOURCE_FILES,
      tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
    })
    const capsuleDir = join(staging, 'capsule')
    await packCapsule({
      outDir: capsuleDir,
      receipt,
      runnerOverlay: '\n',
      provenanceJson: JSON.stringify({ profile: 'stable-demo', model: config.model }),
      sbomJson: JSON.stringify({ spdxVersion: 'SPDX-2.3' }),
      runtimeClosure: {
        catalogRoots: [
          join(config.repoRoot, 'packages'),
          join(config.repoRoot, 'deepseek-harness', 'packages'),
          join(config.repoRoot, 'deepseek-harness', 'vendor'),
        ],
        seedPackages: [
          '@dsh-self-evolving/proposer',
          '@deepseek-ai/dsh-agent-spine-demo',
          '@deepseek-ai/dsh-agent-default-model',
        ],
        entryPackage: '@dsh-self-evolving/proposer',
        entryBin: 'lib/sandbox-worker.js',
      },
    })
    const published = join(staging, 'published')
    await cp(join(capsuleDir, 'runtime'), published, { recursive: true, errorOnExist: true })
    const buildResource = { schemaVersion: 1 as const, builds: receipt.buildResources }
    assertBuildResourceEnvelope(buildResource)
    await writeExclusive(
      join(published, 'build-resource.json'),
      JSON.stringify(buildResource, null, 2) + '\n',
    )
    await mkdir(join(config.stateDir, 'trusted-runtime'), { recursive: true, mode: 0o700 })
    await atomicRenameWithDirSync(published, runtimeRoot)
    await chmod(runtimeRoot, 0o700)
    return runtimeRoot
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * A manifest-less stable proposal directory is a crashed publication, never
 * authority. Move the entire residue aside before retrying so no final entry
 * can collide with the next no-clobber publish. The legacy durable gateway
 * request store is migrated first and kept outside the publication directory:
 * provider calls can replay without adopting any uncommitted evidence bytes.
 */
export async function recoverIncompleteStableProposalPublication(input: {
  stateDir: string
  artifactDir: string
  gatewayStateDir: string
}): Promise<{ quarantined: boolean; quarantinePath: string | null }> {
  const artifactInfo = await stat(input.artifactDir).catch(() => null)
  if (artifactInfo === null) return { quarantined: false, quarantinePath: null }
  if (!artifactInfo.isDirectory()) {
    throw new Error(
      `real proposer: proposal publication path is not a directory: ${input.artifactDir}`,
    )
  }

  const legacyGatewayState = join(input.artifactDir, 'gateway-requests')
  const [legacyInfo, currentInfo] = await Promise.all([
    stat(legacyGatewayState).catch(() => null),
    stat(input.gatewayStateDir).catch(() => null),
  ])
  if (legacyInfo !== null && currentInfo !== null) {
    throw new Error('real proposer: conflicting legacy and current durable gateway request stores')
  }
  if (legacyInfo !== null) {
    if (!legacyInfo.isDirectory()) {
      throw new Error('real proposer: legacy durable gateway request store is not a directory')
    }
    await mkdir(dirname(input.gatewayStateDir), { recursive: true, mode: 0o700 })
    await fsyncDirectory(dirname(input.gatewayStateDir))
    await fsyncDirectory(input.stateDir)
    await rename(legacyGatewayState, input.gatewayStateDir)
    await fsyncDirectory(input.artifactDir)
    await fsyncDirectory(dirname(input.gatewayStateDir))
  }

  const quarantineRoot = join(input.stateDir, 'incomplete-proposal-publications')
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
  await fsyncDirectory(quarantineRoot)
  await fsyncDirectory(input.stateDir)
  const quarantinePath = join(quarantineRoot, `${basename(input.artifactDir)}-${randomUUID()}`)
  await rename(input.artifactDir, quarantinePath)
  await fsyncDirectory(dirname(input.artifactDir))
  await fsyncDirectory(quarantineRoot)
  return { quarantined: true, quarantinePath }
}

async function realProposal(
  config: StableDemoConfig,
  input: StableProposalInput,
): Promise<StableProposal> {
  const artifactDir = join(
    config.stateDir,
    'artifacts',
    `proposal-${input.generation}-${input.attempt}`,
  )
  const gatewayStateDir = join(
    config.stateDir,
    'proposal-gateway-requests',
    `proposal-${input.generation}-${input.attempt}`,
  )
  // Resume gates on the bundle commit marker, not bare proposal.json: a crash
  // between the proposal write and its receipts used to be adopted as a
  // complete evidenced result (issue #55).
  const published = await loadPublishedBundle(artifactDir)
  if (published !== null) {
    const expectedFiles = [
      'gateway-receipts.json',
      'idempotency-key.json',
      'proposal.json',
      'sandbox-resource.json',
    ]
    if (JSON.stringify(Object.keys(published).sort()) !== JSON.stringify(expectedFiles)) {
      throw new Error(`real proposer: published bundle inventory mismatch: ${artifactDir}`)
    }
    const keyBytes = published['idempotency-key.json']
    if (keyBytes === undefined) {
      throw new Error(
        `real proposer: published proposal predates idempotency-key binding and cannot be reused: ${artifactDir}`,
      )
    }
    const recordedKey = JSON.parse(keyBytes) as { idempotencyKey?: string }
    if (recordedKey.idempotencyKey !== input.idempotencyKey) {
      throw new Error(
        `real proposer: published proposal binds a different idempotency key: ${artifactDir}`,
      )
    }
    assertProposalResourceReceipt(JSON.parse(published['sandbox-resource.json']!) as unknown)
    return JSON.parse(published['proposal.json']!) as StableProposal
  }
  await recoverIncompleteStableProposalPublication({
    stateDir: config.stateDir,
    artifactDir,
    gatewayStateDir,
  })
  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const runtimeRoot = await prepareProposalRuntime(config)
  const scratch = await mkdtemp(
    join(config.stateDir, `.proposal-${input.generation}-${input.attempt}-`),
  )
  const route = await loadTrustedRoute()
  const sandboxTimeoutMs = 600_000
  const lockedRoute: ProposalGatewayRoute = {
    provider: 'deepseek',
    endpoint: route.baseUrl,
    model: config.model.requested,
    reasoningEffort: config.model.reasoningEffort,
    maxTokens: config.model.maxOutputTokens,
  }
  const previousKey = process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']
  process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = route.apiKey
  try {
    const mounts = {
      parent: join(scratch, 'input', 'parent'),
      archive: join(scratch, 'input', 'archive'),
      evidence: join(scratch, 'input', 'evidence'),
      contracts: join(scratch, 'input', 'contracts'),
      childrenRoot: join(scratch, 'children'),
    }
    await Promise.all(Object.values(mounts).map((path) => mkdir(path, { recursive: true })))
    await mkdir(join(mounts.parent, 'src'), { recursive: true })
    await cp(
      join(input.parent.sourceRoot, 'src', 'index.ts'),
      join(mounts.parent, 'src', 'index.ts'),
    )
    await writeFile(
      join(mounts.archive, 'catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceLabel: 'DEV_OBSERVED',
        parent: input.parent.candidateId,
      }) + '\n',
    )
    await writeFile(join(mounts.evidence, 'traces.txt'), input.evidenceRefs.join('\n') + '\n')
    await writeFile(
      join(mounts.contracts, 'request.json'),
      JSON.stringify({
        route: lockedRoute,
        contextWindow: config.model.contextWindow,
        llmDeadlineMs: Math.max(60_000, sandboxTimeoutMs - 120_000),
        parentDigest: input.parent.sourceDigest,
        candidateId: input.parent.candidateId,
        width: 3,
      }) + '\n',
    )
    const adapter = new TrustedResponsesAdapter({
      route: lockedRoute,
      apiKeyEnv: 'DSH_SELF_EVOLVING_PROVIDER_API_KEY',
      expectedResponseModel: config.model.effective,
      contextWindow: config.model.contextWindow,
      requestMaxRetries: 12,
      reasoningContinuationMaxTurns: 0,
    })
    const gateway = await startProposalGateway({
      socketPath: join(scratch, 'gateway', 'proposal.sock'),
      route: lockedRoute,
      requestTimeoutMs: sandboxTimeoutMs,
      handle: createProposalGatewayLlmHandler(adapter, lockedRoute),
      // Stable across restarts and outside the manifest-last publication
      // directory: a resumed generation+attempt can quarantine partial
      // evidence while reusing the same request records instead of re-billing.
      stateDir: gatewayStateDir,
    })
    try {
      const result = await runProposalSandbox({
        mounts,
        runtimeRoot,
        command: '/runtime/node',
        args: ['/runtime/node_modules/@dsh-self-evolving/proposer/lib/sandbox-worker.js'],
        timeoutMs: sandboxTimeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        gatewaySocket: gateway.socketPath,
      })
      const resourceBytes = JSON.stringify(result.resource, null, 2) + '\n'
      if (result.exitCode !== 0) {
        await writeIdempotent(join(artifactDir, 'failed-sandbox-resource.json'), resourceBytes)
        throw new Error(`real proposer failed: ${result.stderr}`)
      }
      assertProposalResourceReceipt(result.resource)
      const output = JSON.parse(
        await readFile(join(mounts.childrenRoot, 'proposal-output.json'), 'utf8'),
      ) as {
        parsed: {
          accepted: Array<{
            proposalId: string
            hypothesis: string
            sourceDiff: string
            evidenceRefs: string[]
          }>
        }
      }
      const child = output.parsed.accepted[0]
      if (child === undefined) throw new Error('real proposer returned no admitted child')
      const proposal: StableProposal = {
        proposalId: child.proposalId,
        parentCandidateId: input.parent.candidateId,
        hypothesis: child.hypothesis,
        sourceDiff: child.sourceDiff,
        evidenceRefs: input.evidenceRefs,
        artifactDigest: sha256(JSON.stringify(child)),
      }
      await publishBundle(artifactDir, {
        'proposal.json': JSON.stringify(proposal, null, 2) + '\n',
        'gateway-receipts.json': JSON.stringify(gateway.receipts(), null, 2) + '\n',
        'idempotency-key.json': `${JSON.stringify({ idempotencyKey: input.idempotencyKey }, null, 2)}\n`,
        'sandbox-resource.json': resourceBytes,
      })
      return proposal
    } finally {
      await gateway.close()
    }
  } finally {
    if (previousKey === undefined) delete process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']
    else process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = previousKey
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function readResourceBoundStableBuild(root: string): Promise<BuiltCandidate | null> {
  const stableBytes = await readFile(join(root, 'stable-build.json'), 'utf8').catch(() => null)
  if (stableBytes === null) return null
  const built = JSON.parse(stableBytes) as BuiltCandidate
  if (
    typeof built.candidateId !== 'string' ||
    typeof built.resourceReceiptDigest !== 'string' ||
    built.sourceDigest !== built.candidateId
  ) {
    throw new Error('real builder: cached build identity is incomplete')
  }
  const resource = JSON.parse(await readFile(join(root, 'build-resource.json'), 'utf8')) as unknown
  assertBuildResourceEnvelope(resource, built.candidateId)
  if (built.resourceReceiptDigest !== sha256(JSON.stringify(resource))) {
    throw new Error('real builder: cached resource receipt digest mismatch')
  }
  return built
}

async function realBuild(
  config: StableDemoConfig,
  input: StableBuildInput,
): Promise<BuiltCandidate> {
  const candidateRoot = join(config.stateDir, 'candidates', `generation-${input.generation}`)
  const receiptPath = join(candidateRoot, 'stable-build.json')
  const existing = await readResourceBoundStableBuild(candidateRoot)
  if (existing !== null) return existing
  const stagingRoot = `${candidateRoot}.attempt-${input.attempt}.staging`
  // Crash-resumable claim: stale residue is quarantined aside, never fatal
  // (issue #71). A candidate root without a parseable receipt is likewise a
  // torn publication — quarantine and rebuild.
  if (
    (await stat(candidateRoot).catch(() => null)) !== null &&
    (await readFile(receiptPath, 'utf8').catch(() => null)) === null
  ) {
    await rename(candidateRoot, `${candidateRoot}.incomplete-${Date.now()}`)
  }
  await claimStagingDir(
    stagingRoot,
    {
      generation: input.generation,
      attempt: input.attempt,
      identity: input.proposal.artifactDigest,
    },
    async () => join(config.stateDir, 'candidates'),
  )
  try {
    await mkdir(join(stagingRoot, 'src'), { recursive: true, mode: 0o700 })
    for (const relative of SOURCE_FILES) {
      if (relative === 'src/index.ts' || relative === 'tsconfig.json') continue
      await cp(join(input.parent.sourceRoot, relative), join(stagingRoot, relative))
    }
    await writeFile(
      join(stagingRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          extends: join(config.repoRoot, 'tsconfig.json'),
          compilerOptions: {
            outDir: 'lib',
            rootDir: 'src',
            composite: true,
            tsBuildInfoFile: 'lib/.tsbuildinfo',
            baseUrl: config.repoRoot,
            paths: {
              '@deepseek-ai/cordis': ['deepseek-harness/vendor/cordis/lib/types/index.d.ts'],
              '@deepseek-ai/schemastery': [
                'deepseek-harness/vendor/schemastery/lib/types/index.d.ts',
              ],
              '@deepseek-ai/dsh-system-prompt': [
                'deepseek-harness/packages/core/system-prompt/lib/types/index.d.ts',
              ],
            },
          },
          include: ['src'],
        },
        null,
        2,
      ) + '\n',
    )
    const parentSource = await readFile(join(input.parent.sourceRoot, 'src', 'index.ts'), 'utf8')
    await writeFile(join(stagingRoot, 'src', 'index.ts'), parentSource)
    await applyCandidateSourceDiff(stagingRoot, input.proposal.sourceDiff)
    const receipt = await buildCandidate({
      sourceRoot: stagingRoot,
      sourceFiles: SOURCE_FILES,
      tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
    })
    const resourceReceipt = {
      schemaVersion: 1,
      candidateId: `sha256:${receipt.sourceHash}`,
      builds: receipt.buildResources,
    }
    assertBuildResourceEnvelope(resourceReceipt, resourceReceipt.candidateId)
    const identity = {
      sourceHash: receipt.sourceHash,
      bundleHash: receipt.bundleHash,
      capsuleHash: receipt.capsuleHash,
      proposalDigest: input.proposal.artifactDigest,
      parentCandidateId: input.parent.candidateId,
      resourceReceiptDigest: sha256(JSON.stringify(resourceReceipt)),
    }
    const built: BuiltCandidate = {
      candidateId: `sha256:${receipt.sourceHash}`,
      sourceDigest: `sha256:${receipt.sourceHash}`,
      capsuleDigest: `sha256:${receipt.capsuleHash}`,
      buildManifestDigest: sha256(JSON.stringify(identity)),
      resourceReceiptDigest: identity.resourceReceiptDigest,
      sourceRoot: candidateRoot,
      evidenceRefs: input.proposal.evidenceRefs,
    }
    await writeExclusive(
      join(stagingRoot, 'build-resource.json'),
      JSON.stringify(resourceReceipt, null, 2) + '\n',
    )
    await writeExclusive(
      join(stagingRoot, 'stable-build.json'),
      JSON.stringify(built, null, 2) + '\n',
    )
    await mkdir(join(config.stateDir, 'candidates'), { recursive: true, mode: 0o700 })
    await publishClaimedStagingDir(stagingRoot, candidateRoot)
    return built
  } catch (error) {
    await clearBuildIntent(stagingRoot).catch(() => undefined)
    throw error
  }
}

export async function applyCandidateSourceDiff(
  candidateRoot: string,
  sourceDiff: string,
): Promise<void> {
  if (Buffer.byteLength(sourceDiff) > 256 * 1024 || sourceDiff.includes('\0')) {
    throw new Error('real builder: source diff exceeds containment limits')
  }
  const trimmed = sourceDiff.trim()
  if (trimmed.length === 0 || trimmed.includes('diff --git')) {
    throw new Error('real builder: source diff must be a single hunk-only patch')
  }
  const headerLines = trimmed
    .split('\n')
    .filter((line) => line.startsWith('--- ') || line.startsWith('+++ '))
  if (headerLines.some((line) => line !== '--- a/src/index.ts' && line !== '+++ b/src/index.ts')) {
    throw new Error('real builder: source diff escapes src/index.ts')
  }
  const patch = trimmed.startsWith('@@')
    ? `--- a/src/index.ts\n+++ b/src/index.ts\n${trimmed}\n`
    : `${trimmed}\n`
  if (!patch.includes('--- a/src/index.ts\n+++ b/src/index.ts\n')) {
    throw new Error('real builder: source diff has no exact src/index.ts header')
  }
  const patchPath = join(candidateRoot, '.candidate.patch')
  await writeFile(patchPath, patch, { mode: 0o600, flag: 'wx' })
  try {
    await exec('/usr/bin/git', ['apply', '--check', '--recount', patchPath], {
      cwd: candidateRoot,
    })
    await exec('/usr/bin/git', ['apply', '--recount', patchPath], { cwd: candidateRoot })
  } finally {
    await rm(patchPath, { force: true })
  }
}

function evaluatorRunId(config: StableDemoConfig, spec: StableEvaluationSpec): string {
  return `stable-g5v2-${createHash('sha256')
    .update(`${GATE5_BROKER_PROTOCOL}\0${spec.idempotencyKey}`)
    .digest('hex')
    .slice(0, 24)}`
}

function summaryPath(config: StableDemoConfig, runId: string): string {
  return join(config.stateDir, 'external-evaluator', runId, 'summary.json')
}

export function buildGate5EvaluatorEnvironment(
  config: StableDemoConfig,
  spec: StableEvaluationSpec,
  runId: string,
  reserveUsdMicros: number,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GATE5_RUN_ID: runId,
    GATE5_TASK_IDS: spec.taskId,
    GATE5_ATTEMPTS: '1',
    GATE5_CONCURRENCY: '1',
    GATE5_TRIAL_RESERVE_USD_MICROS: String(reserveUsdMicros),
    GATE5_EXPECTED_CANDIDATE_ID: spec.candidate.candidateId,
    GATE5_EXPECTED_CAPSULE_DIGEST: spec.candidate.capsuleDigest,
    DSH_SELF_EVOLVING_CANDIDATE_ROOT: spec.candidate.sourceRoot,
    ...(spec.candidate.capsuleRoot === undefined
      ? {}
      : { DSH_SELF_EVOLVING_CAPSULE_ROOT: spec.candidate.capsuleRoot }),
    DSH_SELF_EVOLVING_EVALUATOR_ROOT: join(config.stateDir, 'external-evaluator'),
    TB21_DIR: config.terminalBenchRoot,
  }
}

export function mapNormalizedStatus(status: unknown): 'pass' | 'fail' | 'invalid' {
  if (status === 'pass' || status === 'fail' || status === 'invalid') return status
  throw new Error(`real evaluator: unknown normalized status ${JSON.stringify(status)}`)
}

export function selectEfficientObservedTasks(
  observedTaskIds: string[],
  inventory: Array<{ taskId: string; agentTimeoutSec: number }>,
): string[] {
  if (new Set(observedTaskIds).size !== observedTaskIds.length) {
    throw new Error('real capabilities: duplicate observed task id')
  }
  const byId = new Map(inventory.map((task) => [task.taskId, task]))
  const tasks = observedTaskIds.map((taskId) => {
    const task = byId.get(taskId)
    if (
      task === undefined ||
      !Number.isSafeInteger(task.agentTimeoutSec) ||
      task.agentTimeoutSec <= 0
    ) {
      throw new Error(`real capabilities: invalid inventory task ${taskId}`)
    }
    return task
  })
  return tasks
    .sort(
      (left, right) =>
        left.agentTimeoutSec - right.agentTimeoutSec || left.taskId.localeCompare(right.taskId),
    )
    .map((task) => task.taskId)
}

export function selectFailureSeekingObservedTasks(
  observedTaskIds: string[],
  inventory: Array<{
    taskId: string
    agentTimeoutSec: number
    difficulty: 'easy' | 'medium' | 'hard'
  }>,
): string[] {
  if (new Set(observedTaskIds).size !== observedTaskIds.length) {
    throw new Error('real capabilities: duplicate observed task id')
  }
  const byId = new Map(inventory.map((task) => [task.taskId, task]))
  const difficultyRank = { hard: 0, medium: 1, easy: 2 } as const
  return observedTaskIds
    .map((taskId) => {
      const task = byId.get(taskId)
      if (
        task === undefined ||
        !Number.isSafeInteger(task.agentTimeoutSec) ||
        task.agentTimeoutSec <= 0 ||
        difficultyRank[task.difficulty] === undefined
      ) {
        throw new Error(`real capabilities: invalid inventory task ${taskId}`)
      }
      return task
    })
    .sort(
      (left, right) =>
        difficultyRank[left.difficulty] - difficultyRank[right.difficulty] ||
        left.agentTimeoutSec - right.agentTimeoutSec ||
        left.taskId.localeCompare(right.taskId),
    )
    .map((task) => task.taskId)
}

export function createRealEvaluationProvider(config: StableDemoConfig, spec: StableEvaluationSpec) {
  const runId = evaluatorRunId(config, spec)
  const reserveUsd = evaluationReserveUsd(config.limits.budgetUsd, config.limits.solverTrialsMax)
  const reserveUsdMicros = Math.round(reserveUsd * 1_000_000)
  const runEvaluator = () =>
    exec(
      join(config.repoRoot, 'node_modules', '.bin', 'tsx'),
      [join(config.repoRoot, 'scripts', 'run-gate5-real-calibration.ts')],
      {
        cwd: config.repoRoot,
        env: buildGate5EvaluatorEnvironment(config, spec, runId, reserveUsdMicros),
      },
    )
  return {
    async inspect() {
      const directory = await stat(join(config.stateDir, 'external-evaluator', runId)).catch(
        () => null,
      )
      if (directory !== null) {
        const rawTerminal = await stat(
          join(config.stateDir, 'external-evaluator', runId, 'execution-terminal.json'),
        ).catch(() => null)
        if (rawTerminal?.isFile() === true) {
          await runEvaluator()
          return { status: 'terminal' as const, externalJobId: runId }
        }
        throw new Error(`real evaluator: ambiguous incomplete prior external job ${runId}`)
      }
      return { status: 'absent' as const }
    },
    async launch() {
      await mkdir(join(config.stateDir, 'external-evaluator'), { recursive: true, mode: 0o700 })
      await runEvaluator()
      return { externalJobId: runId }
    },
    async collect(externalJobId: string): Promise<EvaluationObservation> {
      if (externalJobId !== runId) throw new Error('real evaluator: external job identity changed')
      const terminal = await stat(
        join(config.stateDir, 'external-evaluator', runId, 'execution-terminal.json'),
      ).catch(() => null)
      if (terminal?.isFile() !== true) {
        throw new Error('real evaluator: broker-v2 run has no terminal authority')
      }
      await runEvaluator()
      const bytes = await readFile(summaryPath(config, runId), 'utf8')
      const summary = JSON.parse(bytes) as {
        schemaVersion?: unknown
        protocol?: unknown
        runId?: unknown
        candidateId?: unknown
        candidateCapsuleDigest?: unknown
        normalized: Array<{
          candidateId?: unknown
          taskId?: unknown
          status: 'pass' | 'fail' | 'invalid'
          reward: number | null
          costUsd: number
          priced?: boolean
        }>
      }
      const row = summary.normalized[0]
      if (row === undefined || summary.normalized.length !== 1) {
        throw new Error('real evaluator: expected one normalized trial')
      }
      // A reused summary may only answer THIS exact evaluation request: its
      // recorded candidate/task identities must equal the current spec.
      // Stamping caller-supplied identity onto unverified evidence would let
      // one candidate inherit another's result (issue #105).
      if (
        summary.schemaVersion !== 2 ||
        summary.protocol !== GATE5_BROKER_PROTOCOL ||
        summary.runId !== runId ||
        summary.candidateId !== spec.candidate.candidateId ||
        summary.candidateCapsuleDigest !== spec.candidate.capsuleDigest ||
        row.candidateId !== spec.candidate.candidateId ||
        row.taskId !== spec.taskId ||
        row.priced !== true ||
        !Number.isFinite(row.costUsd) ||
        row.costUsd < 0
      ) {
        throw new Error(
          'real evaluator: existing evaluator summary does not bind this candidate/task request',
        )
      }
      return {
        candidateId: spec.candidate.candidateId,
        taskId: spec.taskId,
        attemptIndex: 0,
        status: mapNormalizedStatus(row.status),
        reward: row.reward,
        costUsd: row.costUsd,
        // Broker-v2 collection has already rejected missing/unmatched usage;
        // only a signed, reconstructed micro-USD settlement reaches here.
        pricing: { state: 'priced' },
        rawEvidenceDigests: [sha256(bytes)],
      } as EvaluationObservation
    },
  }
}

export async function createRealCapabilities(
  config: StableDemoConfig,
): Promise<StableDemoCapabilities> {
  const baselineRoot = join(config.repoRoot, 'packages', 'candidate-baseline')
  const receipt = await buildCandidate({
    sourceRoot: baselineRoot,
    sourceFiles: SOURCE_FILES,
    tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
  })
  return {
    preflight: () => runDoctor(config),
    baseline: {
      candidateId: `sha256:${receipt.sourceHash}`,
      sourceDigest: `sha256:${receipt.sourceHash}`,
      capsuleDigest: `sha256:${receipt.capsuleHash}`,
      buildManifestDigest: sha256(
        JSON.stringify({
          sourceHash: receipt.sourceHash,
          bundleHash: receipt.bundleHash,
          capsuleHash: receipt.capsuleHash,
        }),
      ),
      sourceRoot: baselineRoot,
      evidenceRefs: [],
    },
    async observedTaskIds() {
      const [split, inventory] = (await Promise.all([
        readFile(config.splitCommitmentPath, 'utf8').then((raw) => JSON.parse(raw)),
        readFile(config.inventoryPath, 'utf8').then((raw) => JSON.parse(raw)),
      ])) as [{ observedTaskIds?: unknown }, { tasks?: unknown }]
      if (
        !Array.isArray(split.observedTaskIds) ||
        split.observedTaskIds.some((id) => typeof id !== 'string')
      ) {
        throw new Error('real capabilities: observed split is invalid')
      }
      if (!Array.isArray(inventory.tasks)) {
        throw new Error('real capabilities: task inventory is invalid')
      }
      return selectEfficientObservedTasks(
        split.observedTaskIds as string[],
        inventory.tasks as Array<{ taskId: string; agentTimeoutSec: number }>,
      )
    },
    propose: (input) => realProposal(config, input),
    build: (input) => realBuild(config, input),
    evaluationProvider: (spec) => createRealEvaluationProvider(config, spec),
    reserveUsd: () => evaluationReserveUsd(config.limits.budgetUsd, config.limits.solverTrialsMax),
  }
}
