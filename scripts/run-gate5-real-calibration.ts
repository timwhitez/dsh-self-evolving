#!/usr/bin/env tsx
/** Gate 5 real Harbor/ACP runner with per-trial host credential brokers. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import {
  chmod,
  lstat,
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
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCandidate, packCapsule } from '../packages/candidate-sdk/src/index.js'
import {
  buildJobConfig,
  buildRegistryEntry,
  jobConfigToYaml,
  normalizeTrial,
  packAcpBinaryArchive,
} from '../benchmark-adapters/terminal-bench/src/index.js'
import {
  TrustedResponsesAdapter,
  type ProposalGatewayRoute,
} from '../packages/dsh-self-evolving-proposer/src/index.js'
import {
  GATE5_BROKER_PROTOCOL,
  GATE5_MODEL_SOCKET_TARGET,
  assertCompleteGate5BrokerEvidence,
  assertExactGate5ReconstructedSummary,
  assertGate5TaskOverlay,
  createGate5BrokerSigningAuthority,
  gate5UsageUsdMicros,
  gate5WorstCaseUsdMicrosPerRequest,
  prepareGate5TaskOverlay,
  sanitizeGate5HarborEnvironment,
  startGate5CredentialBroker,
  writeGate5ExecutionTerminal,
  type Gate5BrokerEvidence,
  type Gate5BrokerPolicy,
  type Gate5TaskOverlayReceipt,
  type Gate5TrialIdentity,
  type Gate5UsageTotal,
} from '../packages/dsh-self-evolving-cli/src/gate5-security.js'
import {
  assertGate5PrebuiltCapsule,
  snapshotGate5PrebuiltCapsule,
} from '../packages/dsh-self-evolving-cli/src/gate5-capsule.js'
import { reconcileGate5Summary } from '../packages/dsh-self-evolving-cli/src/gate5-summary.js'
import { combinePemTrustBundle } from './artifact-trust.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const harborDir = join(repoRoot, 'harbor')
const harborBin = join(harborDir, '.venv', 'bin', 'harbor')
const dshRoot = join(repoRoot, 'deepseek-harness')
const candidateRoot = resolve(
  process.env['DSH_SELF_EVOLVING_CANDIDATE_ROOT'] ??
    join(repoRoot, 'packages', 'candidate-baseline'),
)
const prebuiltCapsuleRoot = process.env['DSH_SELF_EVOLVING_CAPSULE_ROOT']
  ? resolve(process.env['DSH_SELF_EVOLVING_CAPSULE_ROOT'])
  : undefined
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc')
const controllerRoot = resolve(
  process.env['DSH_SELF_EVOLVING_EVALUATOR_ROOT'] ??
    '/var/lib/dsh-self-evolving-controller/gate5-real',
)
const tb21Dir = process.env['TB21_DIR'] ?? '/tmp/tb21/terminal-bench-2-1'
const targetModel = 'deepseek-v4-flash'
const effectiveModel = 'deepseek-v4-flash'
const contextWindow = 1_048_576
const maxTokens = 32_768
const route: ProposalGatewayRoute = {
  provider: 'deepseek-official',
  endpoint: 'https://api.deepseek.com/v1',
  model: effectiveModel,
  reasoningEffort: 'high',
  maxTokens,
}
const officialPricing = {
  currency: 'USD' as const,
  unitTokens: 1_000_000,
  cacheHitInputUsd: 0.0028,
  cacheMissInputUsd: 0.14,
  outputUsd: 0.28,
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  model: effectiveModel,
}

export function brokerPolicyForReservation(trialReservationUsdMicros: number): Gate5BrokerPolicy {
  const seed: Gate5BrokerPolicy = {
    schemaVersion: 1,
    route,
    contextWindow,
    socketTarget: GATE5_MODEL_SOCKET_TARGET,
    maxTransportRetries: 0,
    reasoningContinuationMaxTurns: 0,
    trialReservationUsdMicros,
    pricingUnitTokens: officialPricing.unitTokens,
    cacheHitInputUsdMicrosPerUnit: Math.round(officialPricing.cacheHitInputUsd * 1_000_000),
    cacheMissInputUsdMicrosPerUnit: Math.round(officialPricing.cacheMissInputUsd * 1_000_000),
    outputUsdMicrosPerUnit: Math.round(officialPricing.outputUsd * 1_000_000),
    maxInputTokensPerRequest: contextWindow,
    maxRequests: 1,
    maxRequestBytes: 4 * 1024 * 1024,
    maxPayloadBytesTotal: 4 * 1024 * 1024,
    maxReservedOutputTokens: maxTokens,
    maxResponseBytes: 32 * 1024 * 1024,
    maxConnections: 8,
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 25 * 60_000,
  }
  const worstCasePerRequest = gate5WorstCaseUsdMicrosPerRequest(seed)
  const maxRequests = Math.min(64, Math.floor(trialReservationUsdMicros / worstCasePerRequest))
  if (maxRequests < 1) {
    throw new Error('gate5 runner: trial reservation cannot fund one worst-case provider request')
  }
  return {
    ...seed,
    maxRequests,
    maxPayloadBytesTotal: maxRequests * seed.maxRequestBytes,
    maxReservedOutputTokens: maxRequests * maxTokens,
  }
}
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]
const candidateIdPattern = /^(?:c_[a-z2-7]{26}|sha256:[0-9a-f]{64})$/
const digestPattern = /^sha256:[0-9a-f]{64}$/

interface InventoryTask {
  taskId: string
  agentTimeoutSec: number
}

type DshUsageTotal = Gate5UsageTotal

interface PlannedTrial extends Gate5TrialIdentity, Gate5TaskOverlayReceipt {
  jobName: string
}

interface RunIntent {
  schemaVersion: 2
  protocol: typeof GATE5_BROKER_PROTOCOL
  runId: string
  candidateId: string
  candidateCapsuleDigest: `sha256:${string}`
  capsuleSha256: string
  plannedTrials: number
  broker: {
    publicKeySpki: string
    keyId: `sha256:${string}`
    policy: Gate5BrokerPolicy
  }
  trials: PlannedTrial[]
}

interface ExecutionTerminal {
  schemaVersion: 1
  protocol: typeof GATE5_BROKER_PROTOCOL
  runId: string
  wallSec: number
  trials: Array<{ trialId: string; brokerEvidenceSha256: `sha256:${string}` }>
}

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function execResult(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((done, reject) => {
    execFile(
      file,
      args,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error ? reject(new Error(`${file} failed:\n${stderr}`, { cause: error })) : done(stdout),
    )
  })
}

async function writeAtomicJson(path: string, value: unknown): Promise<string> {
  const bytes = JSON.stringify(value, null, 2) + '\n'
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  return bytes
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await findNamedFiles(path, name)))
    else if (entry.isFile() && entry.name === name) found.push(path)
  }
  return found.sort()
}

async function readDshUsage(trialDir: string): Promise<DshUsageTotal> {
  const sessions = await findNamedFiles(join(trialDir, 'agent', 'dsh-sessions'), 'session.jsonl')
  if (sessions.length !== 1) throw new Error(`expected one DSH session log; got ${sessions.length}`)
  const rows = (await readFile(sessions[0]!, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          data?: { chunk?: { type?: string; usage?: Partial<DshUsageTotal> } }
        },
    )
  const total: DshUsageTotal = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    events: 0,
  }
  for (const row of rows) {
    if (row.data?.chunk?.type !== 'usage') continue
    const usage = row.data.chunk.usage ?? {}
    total.inputTokens += usage.inputTokens ?? 0
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
    total.reasoningTokens += usage.reasoningTokens ?? 0
    total.events += 1
  }
  if (total.events === 0) throw new Error('DSH session has no usage events')
  if (Object.values(total).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('DSH session has invalid usage totals')
  }
  return total
}

function priceUsage(usage: DshUsageTotal, policy: Gate5BrokerPolicy): number {
  return gate5UsageUsdMicros(policy, usage) / 1_000_000
}

async function loadProviderCredential(): Promise<string> {
  const apiKey = process.env['DEEPSEEK_API_KEY']?.trim() ?? ''
  if (apiKey.length === 0) throw new Error('gate5 runner: DEEPSEEK_API_KEY unavailable')
  return apiKey
}

async function startArtifactServer(
  archivePath: string,
  trustDir: string,
): Promise<{ server: Server; url: string; caBundlePath: string }> {
  const gateway = (
    await execResult('/usr/bin/docker', [
      'network',
      'inspect',
      'bridge',
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    ])
  ).trim()
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) {
    throw new Error(`gate5 runner: unexpected Docker gateway ${gateway}`)
  }
  const keyPath = join(trustDir, 'artifact.key')
  const caPath = join(trustDir, 'artifact-ca.crt')
  await execResult('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    caPath,
    '-days',
    '1',
    '-subj',
    '/CN=dsh-self-evolving-gate5-artifact',
    '-addext',
    `subjectAltName=IP:${gateway}`,
  ])
  await chmod(keyPath, 0o600)
  await chmod(caPath, 0o644)
  const [key, cert, archive, publicRoots] = await Promise.all([
    readFile(keyPath),
    readFile(caPath),
    readFile(archivePath),
    readFile('/etc/ssl/certs/ca-certificates.crt'),
  ])
  const caBundlePath = join(trustDir, 'artifact-ca-bundle.crt')
  await writeFile(caBundlePath, combinePemTrustBundle(publicRoots, cert), {
    mode: 0o644,
    flag: 'wx',
  })
  const server = createServer({ key, cert }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/dsh-self-evolving-acp.tar.gz') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(archive.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
    })
    response.end(archive)
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', done)
  })
  const address = server.address() as AddressInfo
  return {
    server,
    url: `https://${gateway}:${address.port}/dsh-self-evolving-acp.tar.gz`,
    caBundlePath,
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  )
}

function brokeredRunnerOverlay(candidateId: string): string {
  return [
    '- id: deepseek-responses',
    "  name: '@dsh-self-evolving/llm-responses'",
    '  config:',
    `    gatewaySocketPath: ${GATE5_MODEL_SOCKET_TARGET}`,
    '    reasoningEffort: high',
    `    maxTokens: ${maxTokens}`,
    `    contextWindow: ${contextWindow}`,
    '    requestDeadlineMs: 1500000',
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
    `    provider: ${route.provider}`,
    `    model: ${targetModel}`,
    '    persistenceRoot: /logs/agent/dsh-sessions',
    '    persistenceCompression: none',
    '    workspaceContext: false',
    '    skills:',
    '      enabled: false',
    '    toolJobs: false',
    '    goals: false',
    "    persona: 'dsh-self-evolving Terminal-Bench baseline. Use bash to inspect and modify the task environment, solve autonomously, and verify the result.'",
    '- id: self-evolving-candidate',
    "  name: '@dsh-self-evolving/candidate-baseline'",
    '  config:',
    `    candidateId: ${candidateId}`,
    '    mode: solve',
    '',
  ].join('\n')
}

async function buildBaselineRuntime(
  workDir: string,
  expectedCandidateId: string,
  expectedCapsuleDigest: `sha256:${string}`,
) {
  if (prebuiltCapsuleRoot !== undefined) {
    const snapshot = await snapshotGate5PrebuiltCapsule({
      sourceRoot: prebuiltCapsuleRoot,
      snapshotRoot: join(workDir, 'prebuilt-capsule'),
      expectedCandidateId,
      expectedCapsuleDigest,
    })
    const packed = await packAcpBinaryArchive(
      join(snapshot.snapshotRoot, 'runtime'),
      join(workDir, 'dsh-self-evolving-acp.tar.gz'),
    )
    await assertGate5PrebuiltCapsule({
      capsuleRoot: snapshot.snapshotRoot,
      expectedCandidateId,
      expectedCapsuleDigest,
    })
    return {
      receipt: { candidateId: expectedCandidateId, capsuleDigest: expectedCapsuleDigest },
      packed,
    }
  }
  const receipt = await buildCandidate({ sourceRoot: candidateRoot, sourceFiles, tscBin })
  if (expectedCandidateId !== `sha256:${receipt.sourceHash}`) {
    throw new Error('gate5 runner: source candidate identity differs from the evaluation plan')
  }
  if (expectedCapsuleDigest !== `sha256:${receipt.capsuleHash}`) {
    throw new Error('gate5 runner: source capsule identity differs from the evaluation plan')
  }
  const capsuleDir = join(workDir, 'capsule')
  await packCapsule({
    outDir: capsuleDir,
    receipt,
    canonicalCandidateId: expectedCandidateId,
    runnerOverlay: brokeredRunnerOverlay(expectedCandidateId),
    provenanceJson: JSON.stringify({
      protocol: GATE5_BROKER_PROTOCOL,
      dshCommit: '47f943859bef60e4160492346772ded9b24f765a',
      model: targetModel,
      effectiveModel,
      reasoningEffort: 'high',
      contextWindow,
      maxTokens,
    }),
    sbomJson: JSON.stringify({ spdxVersion: 'SPDX-2.3' }),
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
  })
  const packed = await packAcpBinaryArchive(
    join(capsuleDir, 'runtime'),
    join(workDir, 'dsh-self-evolving-acp.tar.gz'),
  )
  return {
    receipt: { candidateId: expectedCandidateId, capsuleDigest: expectedCapsuleDigest },
    packed,
  }
}

function trialId(runId: string, taskId: string, attemptIndex: number, index: number): string {
  const suffix = createHash('sha256')
    .update(`${runId}\0${taskId}\0${attemptIndex}`)
    .digest('hex')
    .slice(0, 12)
  return `trial-${String(index).padStart(4, '0')}-${suffix}`
}

function jobName(runId: string, trial: string): string {
  return `g5-${createHash('sha256').update(runId).digest('hex').slice(0, 12)}-${trial}`
}

async function materializeTrialPlan(input: {
  stagingRunDir: string
  runId: string
  candidateId: string
  tasks: InventoryTask[]
  attempts: number
}): Promise<PlannedTrial[]> {
  const trials: PlannedTrial[] = []
  let index = 0
  for (const task of input.tasks) {
    for (let attemptIndex = 0; attemptIndex < input.attempts; attemptIndex += 1) {
      const id = trialId(input.runId, task.taskId, attemptIndex, index)
      const receipt = await prepareGate5TaskOverlay({
        sourceDir: join(tb21Dir, task.taskId),
        destinationDir: join(input.stagingRunDir, 'task-overlays', id),
      })
      trials.push({
        runId: input.runId,
        candidateId: input.candidateId,
        trialId: id,
        taskId: task.taskId,
        attemptIndex,
        jobName: jobName(input.runId, id),
        ...receipt,
      })
      index += 1
    }
  }
  return trials
}

async function readRunIntent(
  runDir: string,
  expectedRunId: string,
  expectedCandidateId: string,
  expectedCapsuleDigest: `sha256:${string}`,
  taskIds: string[],
  attempts: number,
  expectedBrokerPolicy: Gate5BrokerPolicy,
): Promise<RunIntent> {
  const parsed = JSON.parse(await readFile(join(runDir, 'run-intent.json'), 'utf8')) as RunIntent
  if (
    parsed?.schemaVersion !== 2 ||
    parsed.protocol !== GATE5_BROKER_PROTOCOL ||
    parsed.runId !== expectedRunId ||
    parsed.candidateId !== expectedCandidateId ||
    !candidateIdPattern.test(parsed.candidateId) ||
    parsed.candidateCapsuleDigest !== expectedCapsuleDigest ||
    !digestPattern.test(parsed.candidateCapsuleDigest) ||
    !/^[0-9a-f]{64}$/.test(parsed.capsuleSha256) ||
    parsed.plannedTrials !== taskIds.length * attempts ||
    !Array.isArray(parsed.trials) ||
    parsed.trials.length !== parsed.plannedTrials ||
    parsed.broker?.policy?.socketTarget !== GATE5_MODEL_SOCKET_TARGET ||
    stableJson(parsed.broker.policy) !== stableJson(expectedBrokerPolicy) ||
    typeof parsed.broker.publicKeySpki !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(parsed.broker.keyId) ||
    sha256(Buffer.from(parsed.broker.publicKeySpki, 'base64')) !== parsed.broker.keyId
  ) {
    throw new Error('reconcile: trusted broker run intent is invalid or obsolete')
  }
  const expectedTrials = taskIds.flatMap((taskId) =>
    Array.from({ length: attempts }, (_, attemptIndex) => `${taskId}\0${attemptIndex}`),
  )
  const actualTrials = parsed.trials.map((trial) => `${trial.taskId}\0${trial.attemptIndex}`)
  if (stableJson(actualTrials) !== stableJson(expectedTrials)) {
    throw new Error('reconcile: trusted run intent trial matrix differs from the request')
  }
  const seen = new Set<string>()
  for (const [index, trial] of parsed.trials.entries()) {
    if (
      trial.schemaVersion !== 1 ||
      trial.runId !== parsed.runId ||
      trial.candidateId !== parsed.candidateId ||
      trial.trialId !== trialId(parsed.runId, trial.taskId, trial.attemptIndex, index) ||
      trial.jobName !== jobName(parsed.runId, trial.trialId) ||
      !/^sha256:[0-9a-f]{64}$/.test(trial.originalSha256) ||
      !/^sha256:[0-9a-f]{64}$/.test(trial.overlaySha256) ||
      trial.agentNetworkMode !== 'no-network' ||
      seen.has(trial.trialId)
    ) {
      throw new Error('reconcile: trusted run intent contains an invalid trial')
    }
    seen.add(trial.trialId)
    await assertGate5TaskOverlay({
      sourceDir: join(tb21Dir, trial.taskId),
      destinationDir: join(runDir, 'task-overlays', trial.trialId),
      receipt: trial,
    })
  }
  return parsed
}

async function readTerminal(runDir: string, intent: RunIntent): Promise<ExecutionTerminal> {
  const parsed = JSON.parse(
    await readFile(join(runDir, 'execution-terminal.json'), 'utf8'),
  ) as ExecutionTerminal
  if (
    parsed?.schemaVersion !== 1 ||
    parsed.protocol !== GATE5_BROKER_PROTOCOL ||
    parsed.runId !== intent.runId ||
    typeof parsed.wallSec !== 'number' ||
    !Number.isFinite(parsed.wallSec) ||
    parsed.wallSec < 0 ||
    !Array.isArray(parsed.trials) ||
    parsed.trials.length !== intent.trials.length
  ) {
    throw new Error('reconcile: execution terminal marker is invalid')
  }
  for (const [index, row] of parsed.trials.entries()) {
    if (
      row.trialId !== intent.trials[index]?.trialId ||
      !/^sha256:[0-9a-f]{64}$/.test(row.brokerEvidenceSha256)
    ) {
      throw new Error('reconcile: execution terminal broker matrix is invalid')
    }
  }
  return parsed
}

async function trialDirectory(runDir: string, trial: PlannedTrial): Promise<string> {
  const jobDir = join(runDir, 'jobs', trial.jobName)
  const entries = await readdir(jobDir, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.includes('__'))
    .map((entry) => join(jobDir, entry.name))
  if (candidates.length !== 1) {
    throw new Error(
      `reconcile: expected one Harbor trial for ${trial.trialId}; got ${candidates.length}`,
    )
  }
  return candidates[0]!
}

async function collectRun(input: {
  runDir: string
  intent: RunIntent
  terminal: ExecutionTerminal
}) {
  const normalized = []
  for (const [index, trial] of input.intent.trials.entries()) {
    const trialDir = await trialDirectory(input.runDir, trial)
    const result = await stat(join(trialDir, 'result.json')).catch(() => null)
    if (result?.isFile() !== true) {
      throw new Error(`reconcile: terminal result missing: ${trial.trialId}`)
    }
    const configRaw = JSON.parse(await readFile(join(trialDir, 'config.json'), 'utf8')) as {
      task?: { path?: unknown }
    }
    const expectedTaskPath = resolve(join(input.runDir, 'task-overlays', trial.trialId))
    if (
      typeof configRaw.task?.path !== 'string' ||
      resolve(configRaw.task.path) !== expectedTaskPath
    ) {
      throw new Error(`reconcile: Harbor task path differs from plan: ${trial.trialId}`)
    }
    const evidencePath = join(input.runDir, 'broker-evidence', `${trial.trialId}.json`)
    const evidenceBytes = await readFile(evidencePath)
    if (sha256(evidenceBytes) !== input.terminal.trials[index]?.brokerEvidenceSha256) {
      throw new Error(`reconcile: broker evidence digest mismatch: ${trial.trialId}`)
    }
    const broker = assertCompleteGate5BrokerEvidence(JSON.parse(evidenceBytes.toString('utf8')), {
      identity: {
        runId: trial.runId,
        candidateId: trial.candidateId,
        trialId: trial.trialId,
        taskId: trial.taskId,
        attemptIndex: trial.attemptIndex,
      },
      policy: input.intent.broker.policy,
      publicKeySpki: input.intent.broker.publicKeySpki,
    })
    const usage = await readDshUsage(trialDir)
    if (stableJson(usage) !== stableJson(broker.usage)) {
      throw new Error(`reconcile: broker/session usage mismatch: ${trial.trialId}`)
    }
    const attributionPath = join(trialDir, 'attribution.json')
    const expectedAttribution = {
      candidate_id: trial.candidateId,
      task_id: trial.taskId,
      attempt_index: trial.attemptIndex,
    }
    const existingAttribution = await readFile(attributionPath, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      },
    )
    if (existingAttribution === null) {
      await writeAtomicJson(attributionPath, expectedAttribution)
    } else if (stableJson(JSON.parse(existingAttribution)) !== stableJson(expectedAttribution)) {
      throw new Error(`reconcile: attribution conflicts with plan: ${trial.trialId}`)
    }
    const record = await normalizeTrial({
      trialDir,
      expectedCandidateId: trial.candidateId,
      taskId: trial.taskId,
      expectedAttemptIndex: trial.attemptIndex,
      requireAcpEvidence: true,
    })
    normalized.push({
      ...record,
      usage,
      costUsd: priceUsage(usage, input.intent.broker.policy),
      priced: true,
      brokerEvidence: {
        protocol: GATE5_BROKER_PROTOCOL,
        digest: input.terminal.trials[index]!.brokerEvidenceSha256,
        keyId: input.intent.broker.keyId,
        requests: broker.dispatchedRequests,
        reservedWorstCaseUsdMicros: broker.reservedWorstCaseUsdMicros,
        settledUsageUsdMicros: broker.settledUsageUsdMicros,
      },
    })
  }
  const summary = {
    schemaVersion: 2,
    protocol: GATE5_BROKER_PROTOCOL,
    runId: input.intent.runId,
    capabilityMode: 'real-official-responses-harbor-acp-host-broker',
    candidateId: input.intent.candidateId,
    candidateCapsuleDigest: input.intent.candidateCapsuleDigest,
    capsuleSha256: input.intent.capsuleSha256,
    route: {
      requestedModel: targetModel,
      effectiveModel,
      reasoningEffort: 'high',
      contextWindow,
      maxTokens,
      wireApi: 'responses',
      brokerSocketTarget: GATE5_MODEL_SOCKET_TARGET,
    },
    brokerPolicy: input.intent.broker.policy,
    brokerKeyId: input.intent.broker.keyId,
    officialPricing,
    plannedTrials: input.intent.plannedTrials,
    collectedTrials: normalized.length,
    wallSec: input.terminal.wallSec,
    reconciledFromTerminalRaw: true,
    normalized,
  }
  const summaryBytes = JSON.stringify(summary, null, 2) + '\n'
  await reconcileGate5Summary({
    path: join(input.runDir, 'summary.json'),
    bytes: summaryBytes,
  })
  process.stdout.write(
    JSON.stringify({
      runId: input.intent.runId,
      candidateId: input.intent.candidateId,
      candidateCapsuleDigest: input.intent.candidateCapsuleDigest,
      capsuleSha256: input.intent.capsuleSha256,
      plannedTrials: input.intent.plannedTrials,
      collectedTrials: normalized.length,
      statuses: normalized.map((row) => row.status),
      wallSec: input.terminal.wallSec,
      summaryHash: sha256(summaryBytes),
      runDir: input.runDir,
    }) + '\n',
  )
  return summary
}

async function validateExistingSummary(
  runDir: string,
  intent: RunIntent,
  terminal: ExecutionTerminal,
  bytes: string,
): Promise<string> {
  const summary = JSON.parse(bytes) as {
    schemaVersion?: unknown
    protocol?: unknown
    runId?: unknown
    candidateId?: unknown
    candidateCapsuleDigest?: unknown
    capsuleSha256?: unknown
    plannedTrials?: unknown
    collectedTrials?: unknown
    brokerKeyId?: unknown
    wallSec?: unknown
    reconciledFromTerminalRaw?: unknown
    normalized?: Array<Record<string, unknown>>
  }
  if (
    summary.schemaVersion !== 2 ||
    summary.protocol !== GATE5_BROKER_PROTOCOL ||
    summary.runId !== intent.runId ||
    summary.candidateId !== intent.candidateId ||
    summary.candidateCapsuleDigest !== intent.candidateCapsuleDigest ||
    summary.capsuleSha256 !== intent.capsuleSha256 ||
    summary.plannedTrials !== intent.plannedTrials ||
    summary.collectedTrials !== intent.plannedTrials ||
    summary.brokerKeyId !== intent.broker.keyId ||
    summary.wallSec !== terminal.wallSec ||
    summary.reconciledFromTerminalRaw !== true ||
    !Array.isArray(summary.normalized) ||
    summary.normalized.length !== intent.plannedTrials
  ) {
    throw new Error('gate5 runner: existing summary does not bind the broker run intent')
  }
  const expectedRows: Array<Record<string, unknown>> = []
  for (const [index, trial] of intent.trials.entries()) {
    const row = summary.normalized[index]!
    const trialDir = await trialDirectory(runDir, trial)
    if ((await stat(join(trialDir, 'result.json')).catch(() => null))?.isFile() !== true) {
      throw new Error(`gate5 runner: replayed trial result is missing: ${trial.trialId}`)
    }
    const config = JSON.parse(await readFile(join(trialDir, 'config.json'), 'utf8')) as {
      task?: { path?: unknown }
    }
    if (
      typeof config.task?.path !== 'string' ||
      resolve(config.task.path) !== resolve(join(runDir, 'task-overlays', trial.trialId))
    ) {
      throw new Error(`gate5 runner: replayed task path differs from plan: ${trial.trialId}`)
    }
    const evidenceBytes = await readFile(join(runDir, 'broker-evidence', `${trial.trialId}.json`))
    if (sha256(evidenceBytes) !== terminal.trials[index]?.brokerEvidenceSha256) {
      throw new Error(`gate5 runner: replayed broker digest mismatch: ${trial.trialId}`)
    }
    const broker = assertCompleteGate5BrokerEvidence(JSON.parse(evidenceBytes.toString('utf8')), {
      identity: {
        runId: trial.runId,
        candidateId: trial.candidateId,
        trialId: trial.trialId,
        taskId: trial.taskId,
        attemptIndex: trial.attemptIndex,
      },
      policy: intent.broker.policy,
      publicKeySpki: intent.broker.publicKeySpki,
    })
    const usage = await readDshUsage(trialDir)
    if (stableJson(usage) !== stableJson(broker.usage)) {
      throw new Error(`gate5 runner: existing summary trial binding is invalid: ${trial.trialId}`)
    }
    const record = await normalizeTrial({
      trialDir,
      expectedCandidateId: trial.candidateId,
      taskId: trial.taskId,
      expectedAttemptIndex: trial.attemptIndex,
      requireAcpEvidence: true,
    })
    const expectedRow = {
      ...record,
      usage,
      costUsd: priceUsage(usage, intent.broker.policy),
      priced: true,
      brokerEvidence: {
        protocol: GATE5_BROKER_PROTOCOL,
        digest: terminal.trials[index]!.brokerEvidenceSha256,
        keyId: intent.broker.keyId,
        requests: broker.dispatchedRequests,
        reservedWorstCaseUsdMicros: broker.reservedWorstCaseUsdMicros,
        settledUsageUsdMicros: broker.settledUsageUsdMicros,
      },
    }
    if (stableJson(row) !== stableJson(expectedRow)) {
      throw new Error(`gate5 runner: existing summary trial binding is invalid: ${trial.trialId}`)
    }
    expectedRows.push(expectedRow)
  }
  const expectedSummary = {
    schemaVersion: 2,
    protocol: GATE5_BROKER_PROTOCOL,
    runId: intent.runId,
    capabilityMode: 'real-official-responses-harbor-acp-host-broker',
    candidateId: intent.candidateId,
    candidateCapsuleDigest: intent.candidateCapsuleDigest,
    capsuleSha256: intent.capsuleSha256,
    route: {
      requestedModel: targetModel,
      effectiveModel,
      reasoningEffort: 'high',
      contextWindow,
      maxTokens,
      wireApi: 'responses',
      brokerSocketTarget: GATE5_MODEL_SOCKET_TARGET,
    },
    brokerPolicy: intent.broker.policy,
    brokerKeyId: intent.broker.keyId,
    officialPricing,
    plannedTrials: intent.plannedTrials,
    collectedTrials: expectedRows.length,
    wallSec: terminal.wallSec,
    reconciledFromTerminalRaw: true,
    normalized: expectedRows,
  }
  assertExactGate5ReconstructedSummary(summary, expectedSummary)
  return JSON.stringify(expectedSummary, null, 2) + '\n'
}

async function scanFileForSecret(path: string, secret: Buffer): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const chunkSize = 64 * 1024
    const buffer = Buffer.alloc(chunkSize)
    let overlap = Buffer.alloc(0)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) return false
      position += bytesRead
      const candidate = Buffer.concat([overlap, buffer.subarray(0, bytesRead)])
      if (candidate.includes(secret)) return true
      const overlapSize = Math.max(0, secret.byteLength - 1)
      overlap = Buffer.from(candidate.subarray(Math.max(0, candidate.byteLength - overlapSize)))
    }
  } finally {
    await handle.close()
  }
}

async function assertSecretAbsent(root: string, apiKey: string): Promise<void> {
  const secret = Buffer.from(apiKey)
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && (await scanFileForSecret(path, secret))) {
        throw new Error('gate5 runner: provider credential appeared in persisted run evidence')
      }
    }
  }
  await visit(root)
}

async function runTrial(input: {
  runDir: string
  trial: PlannedTrial
  task: InventoryTask
  archiveUrl: string
  archiveSha256: string
  caBundlePath: string
  socketRoot: string
  brokerPolicy: Gate5BrokerPolicy
  authority: ReturnType<typeof createGate5BrokerSigningAuthority>
}): Promise<{ trialId: string; evidenceBytes: string }> {
  const socketPath = join(
    input.socketRoot,
    `${createHash('sha256')
      .update(`${input.trial.runId}\0${input.trial.candidateId}\0${input.trial.trialId}`)
      .digest('hex')
      .slice(0, 24)}.sock`,
  )
  const adapter = new TrustedResponsesAdapter({
    route,
    expectedResponseModel: effectiveModel,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    contextWindow,
    requestMaxRetries: input.brokerPolicy.maxTransportRetries,
    reasoningContinuationMaxTurns: input.brokerPolicy.reasoningContinuationMaxTurns,
  })
  const broker = await startGate5CredentialBroker({
    socketPath,
    stateDir: join(input.runDir, 'broker-state', input.trial.trialId),
    identity: {
      runId: input.trial.runId,
      candidateId: input.trial.candidateId,
      trialId: input.trial.trialId,
      taskId: input.trial.taskId,
      attemptIndex: input.trial.attemptIndex,
    },
    policy: input.brokerPolicy,
    adapter,
    authority: input.authority,
  })
  let jobError: unknown
  let evidence: Gate5BrokerEvidence
  try {
    const registry = buildRegistryEntry({
      candidateId: input.trial.candidateId,
      agentName: 'dsh-self-evolving-gate5-brokered',
      version: input.trial.candidateId,
      archiveUrl: input.archiveUrl,
      archiveSha256: input.archiveSha256,
      cmd: './dsh-self-evolving-acp',
    })
    const config = buildJobConfig({
      jobName: input.trial.jobName,
      registryEntry: registry,
      modelName: '',
      tasks: [
        {
          taskId: input.trial.taskId,
          path: join(input.runDir, 'task-overlays', input.trial.trialId),
        },
      ],
      nAttempts: 1,
      nConcurrentTrials: 1,
      verifier: {
        timeoutSec: input.task.agentTimeoutSec,
        agentTimeoutSec: input.task.agentTimeoutSec,
      },
      idempotencyKey: `gate5/${input.trial.runId}/${input.trial.candidateId}/${input.trial.trialId}`,
      jobsDir: join(input.runDir, 'jobs'),
      environment: {
        env: { CURL_CA_BUNDLE: '/run/dsh-self-evolving/artifact-ca-bundle.crt' },
        mounts: [
          {
            type: 'bind',
            source: input.caBundlePath,
            target: '/run/dsh-self-evolving/artifact-ca-bundle.crt',
            read_only: true,
          },
          {
            type: 'bind',
            source: broker.socketPath,
            target: GATE5_MODEL_SOCKET_TARGET,
            read_only: true,
          },
        ],
      },
    })
    const configPath = join(input.runDir, 'job-configs', `${input.trial.trialId}.yaml`)
    await writeFile(configPath, jobConfigToYaml(config), { mode: 0o600, flag: 'wx' })
    await execResult(harborBin, ['job', 'start', '-c', configPath], {
      cwd: harborDir,
      env: sanitizeGate5HarborEnvironment(process.env),
    })
  } catch (error) {
    jobError = error
  } finally {
    evidence = await broker.complete()
  }
  const evidencePath = join(input.runDir, 'broker-evidence', `${input.trial.trialId}.json`)
  const evidenceBytes = await writeAtomicJson(evidencePath, evidence)
  if (jobError !== undefined) throw jobError
  assertCompleteGate5BrokerEvidence(evidence, {
    identity: {
      runId: input.trial.runId,
      candidateId: input.trial.candidateId,
      trialId: input.trial.trialId,
      taskId: input.trial.taskId,
      attemptIndex: input.trial.attemptIndex,
    },
    policy: input.brokerPolicy,
    publicKeySpki: input.authority.publicKeySpki,
  })
  return { trialId: input.trial.trialId, evidenceBytes }
}

async function runTrialsWithLimit<T>(
  trials: PlannedTrial[],
  concurrency: number,
  run: (trial: PlannedTrial) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(trials.length)
  let cursor = 0
  let firstError: unknown
  const workers = Array.from({ length: Math.min(concurrency, trials.length) }, async () => {
    for (;;) {
      if (firstError !== undefined) return
      const index = cursor
      cursor += 1
      const trial = trials[index]
      if (trial === undefined) return
      try {
        results[index] = await run(trial)
      } catch (error) {
        firstError ??= error
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError !== undefined) throw firstError
  return results
}

async function main(): Promise<void> {
  const runId = process.env['GATE5_RUN_ID'] ?? 'gate5-real-smoke-v1'
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(runId)) throw new Error('unsafe run id')
  const taskIds = (process.env['GATE5_TASK_IDS'] ?? 'fix-git')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) {
    throw new Error('task list must be non-empty and unique')
  }
  const attempts = Number(process.env['GATE5_ATTEMPTS'] ?? '1')
  const concurrency = Number(process.env['GATE5_CONCURRENCY'] ?? '1')
  const trialReservationUsdMicros = Number(process.env['GATE5_TRIAL_RESERVE_USD_MICROS'] ?? '')
  const expectedCandidateId = process.env['GATE5_EXPECTED_CANDIDATE_ID'] ?? ''
  const expectedCapsuleDigest = process.env['GATE5_EXPECTED_CAPSULE_DIGEST'] ?? ''
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error('attempts must be 1 through 10')
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('concurrency must be 1 through 16')
  }
  if (!Number.isSafeInteger(trialReservationUsdMicros) || trialReservationUsdMicros < 1) {
    throw new Error('gate5 runner: GATE5_TRIAL_RESERVE_USD_MICROS must be a positive integer')
  }
  if (!candidateIdPattern.test(expectedCandidateId)) {
    throw new Error('gate5 runner: GATE5_EXPECTED_CANDIDATE_ID is invalid')
  }
  if (!digestPattern.test(expectedCapsuleDigest)) {
    throw new Error('gate5 runner: GATE5_EXPECTED_CAPSULE_DIGEST is invalid')
  }
  const brokerPolicy = brokerPolicyForReservation(trialReservationUsdMicros)
  const split = JSON.parse(
    await readFile(join(repoRoot, 'evidence', 'gate5', 'split-commitment.json'), 'utf8'),
  ) as { observedTaskIds: string[] }
  const observed = new Set(split.observedTaskIds)
  if (taskIds.some((taskId) => !observed.has(taskId))) {
    throw new Error('runner accepts only published DEV_OBSERVED task ids')
  }
  const inventory = JSON.parse(
    await readFile(join(repoRoot, 'evidence', 'calibration', 'tb21-inventory.json'), 'utf8'),
  ) as { tasks: InventoryTask[] }
  const byId = new Map(inventory.tasks.map((task) => [task.taskId, task]))
  const tasks = taskIds.map((taskId) => {
    const task = byId.get(taskId)
    if (task === undefined) throw new Error(`task missing from inventory: ${taskId}`)
    return task
  })
  for (const task of tasks) {
    await stat(join(tb21Dir, task.taskId, 'task.toml')).catch(() => {
      throw new Error(`fixed TB 2.1 task materialization missing: ${task.taskId}`)
    })
  }
  await mkdir(controllerRoot, { recursive: true, mode: 0o700 })
  await chmod(controllerRoot, 0o700)
  const runDir = join(controllerRoot, runId)
  const existingRunDir = await lstat(runDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existingRunDir !== null) {
    if (!existingRunDir.isDirectory() || existingRunDir.isSymbolicLink()) {
      throw new Error('gate5 runner: existing run path is not a real directory')
    }
    const intent = await readRunIntent(
      runDir,
      runId,
      expectedCandidateId,
      expectedCapsuleDigest as `sha256:${string}`,
      taskIds,
      attempts,
      brokerPolicy,
    )
    const terminal = await readTerminal(runDir, intent).catch(() => null)
    const summaryPath = join(runDir, 'summary.json')
    const existing = await readFile(summaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing !== null) {
      if (terminal === null) throw new Error('gate5 runner: summary has no terminal authority')
      const existingText = existing.toString('utf8')
      try {
        JSON.parse(existingText)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        await collectRun({ runDir, intent, terminal })
        return
      }
      const reconstructed = await validateExistingSummary(runDir, intent, terminal, existingText)
      await reconcileGate5Summary({ path: summaryPath, bytes: reconstructed })
      process.stdout.write(reconstructed)
      return
    }
    if (terminal === null) {
      throw new Error('gate5 runner: ambiguous incomplete broker run; paid calls will not replay')
    }
    await collectRun({ runDir, intent, terminal })
    return
  }

  const providerCredential = await loadProviderCredential()
  const originalCredential = process.env['DEEPSEEK_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  const workDir = await mkdtemp(join(tmpdir(), `${runId}-`))
  let socketRoot: string | undefined
  let artifact: Awaited<ReturnType<typeof startArtifactServer>> | undefined
  try {
    socketRoot = await mkdtemp(join(tmpdir(), 'dsh-g5-sockets-'))
    await chmod(socketRoot, 0o700)
    const { receipt, packed } = await buildBaselineRuntime(
      workDir,
      expectedCandidateId,
      expectedCapsuleDigest as `sha256:${string}`,
    )
    const authority = createGate5BrokerSigningAuthority()
    const stagingRunDir = `${runDir}.staging-${process.pid}-${randomUUID()}`
    await mkdir(stagingRunDir, { recursive: false, mode: 0o700 })
    try {
      const trials = await materializeTrialPlan({
        stagingRunDir,
        runId,
        candidateId: receipt.candidateId,
        tasks,
        attempts,
      })
      await writeAtomicJson(join(stagingRunDir, 'run-intent.json'), {
        schemaVersion: 2,
        protocol: GATE5_BROKER_PROTOCOL,
        runId,
        candidateId: receipt.candidateId,
        candidateCapsuleDigest: receipt.capsuleDigest,
        capsuleSha256: packed.sha256,
        plannedTrials: trials.length,
        broker: {
          publicKeySpki: authority.publicKeySpki,
          keyId: authority.keyId,
          policy: brokerPolicy,
        },
        trials,
      } satisfies RunIntent)
      await mkdir(join(stagingRunDir, 'job-configs'), { mode: 0o700 })
      await mkdir(join(stagingRunDir, 'broker-evidence'), { mode: 0o700 })
      await mkdir(join(stagingRunDir, 'broker-state'), { mode: 0o700 })
      await mkdir(join(stagingRunDir, 'jobs'), { mode: 0o700 })
      await rename(stagingRunDir, runDir)
      const controllerDirectory = await open(controllerRoot, 'r')
      try {
        await controllerDirectory.sync()
      } finally {
        await controllerDirectory.close()
      }
    } catch (error) {
      await rm(stagingRunDir, { recursive: true, force: true })
      throw error
    }
    const intent = await readRunIntent(
      runDir,
      runId,
      expectedCandidateId,
      expectedCapsuleDigest as `sha256:${string}`,
      taskIds,
      attempts,
      brokerPolicy,
    )
    artifact = await startArtifactServer(packed.archivePath, workDir)
    process.env['DEEPSEEK_API_KEY'] = providerCredential
    const startedAt = Date.now()
    const taskById = new Map(tasks.map((task) => [task.taskId, task]))
    const results = await runTrialsWithLimit(intent.trials, concurrency, async (trial) => {
      const task = taskById.get(trial.taskId)
      if (task === undefined) {
        throw new Error(`gate5 runner: planned task disappeared: ${trial.taskId}`)
      }
      return runTrial({
        runDir,
        trial,
        task,
        archiveUrl: artifact!.url,
        archiveSha256: packed.sha256,
        caBundlePath: artifact!.caBundlePath,
        socketRoot: socketRoot!,
        brokerPolicy,
        authority,
      })
    })
    delete process.env['DEEPSEEK_API_KEY']
    const finalIntent = await readRunIntent(
      runDir,
      runId,
      expectedCandidateId,
      expectedCapsuleDigest as `sha256:${string}`,
      taskIds,
      attempts,
      brokerPolicy,
    )
    if (stableJson(finalIntent) !== stableJson(intent)) {
      throw new Error('gate5 runner: run intent changed during execution')
    }
    await assertSecretAbsent(runDir, providerCredential)
    const terminal: ExecutionTerminal = {
      schemaVersion: 1,
      protocol: GATE5_BROKER_PROTOCOL,
      runId,
      wallSec: (Date.now() - startedAt) / 1000,
      trials: results.map((result) => ({
        trialId: result.trialId,
        brokerEvidenceSha256: sha256(result.evidenceBytes),
      })),
    }
    const terminalTrials = await Promise.all(
      results.map(async (result, index) => {
        const trial = intent.trials[index]
        if (trial === undefined || result.trialId !== trial.trialId) {
          throw new Error('gate5 runner: terminal result order differs from run intent')
        }
        return {
          evidence: JSON.parse(result.evidenceBytes) as unknown,
          identity: {
            runId: trial.runId,
            candidateId: trial.candidateId,
            trialId: trial.trialId,
            taskId: trial.taskId,
            attemptIndex: trial.attemptIndex,
          },
          policy: brokerPolicy,
          publicKeySpki: intent.broker.publicKeySpki,
          sessionUsage: await readDshUsage(await trialDirectory(runDir, trial)),
        }
      }),
    )
    await writeGate5ExecutionTerminal({
      path: join(runDir, 'execution-terminal.json'),
      value: terminal,
      trials: terminalTrials,
    })
    await collectRun({ runDir, intent, terminal })
  } finally {
    delete process.env['DEEPSEEK_API_KEY']
    if (originalCredential !== undefined) process.env['DEEPSEEK_API_KEY'] = originalCredential
    if (artifact !== undefined) await closeServer(artifact.server).catch(() => undefined)
    if (socketRoot !== undefined) await rm(socketRoot, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
