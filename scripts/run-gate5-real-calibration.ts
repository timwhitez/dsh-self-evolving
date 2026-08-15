#!/usr/bin/env tsx
/** Gate 5 real Harbor/ACP runner. Defaults to one observed-task smoke. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
const officialPricing = {
  currency: 'USD' as const,
  unitTokens: 1_000_000,
  cacheHitInputUsd: 0.0028,
  cacheMissInputUsd: 0.14,
  outputUsd: 0.28,
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  model: 'deepseek-v4-flash',
}
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

interface InventoryTask {
  taskId: string
  agentTimeoutSec: number
}

interface DshUsageTotal {
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  reasoningTokens: number
  events: number
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await findNamedFiles(path, name)))
    else if (entry.name === name) found.push(path)
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
    outputTokens: 0,
    reasoningTokens: 0,
    events: 0,
  }
  for (const row of rows) {
    if (row.data?.chunk?.type !== 'usage') continue
    const usage = row.data.chunk.usage ?? {}
    total.inputTokens += usage.inputTokens ?? 0
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
    total.reasoningTokens += usage.reasoningTokens ?? 0
    total.events++
  }
  if (total.events === 0) throw new Error('DSH session has no usage events')
  return total
}

function priceUsage(usage: DshUsageTotal): number {
  return (
    (usage.inputTokens * officialPricing.cacheMissInputUsd +
      usage.cacheReadTokens * officialPricing.cacheHitInputUsd +
      usage.outputTokens * officialPricing.outputUsd) /
    officialPricing.unitTokens
  )
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

async function loadTrustedRoute(): Promise<{ apiKey: string }> {
  const apiKey = process.env['DEEPSEEK_API_KEY'] ?? ''
  if (apiKey.length === 0) throw new Error('gate5 runner: DEEPSEEK_API_KEY unavailable')
  return { apiKey }
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

async function buildBaselineRuntime(workDir: string) {
  if (prebuiltCapsuleRoot !== undefined) {
    const [manifestInfo, sumsInfo, launcherInfo] = await Promise.all([
      stat(join(prebuiltCapsuleRoot, 'capsule.json')).catch(() => null),
      stat(join(prebuiltCapsuleRoot, 'SHA256SUMS')).catch(() => null),
      stat(join(prebuiltCapsuleRoot, 'runtime', 'credential-launcher.sh')).catch(() => null),
    ])
    if (
      manifestInfo?.isFile() !== true ||
      sumsInfo?.isFile() !== true ||
      launcherInfo?.isFile() !== true ||
      (launcherInfo.mode & 0o111) === 0
    ) {
      throw new Error('gate5 runner: prebuilt v0.1.1 capsule is incomplete')
    }
    const manifest = JSON.parse(
      await readFile(join(prebuiltCapsuleRoot, 'capsule.json'), 'utf8'),
    ) as { candidateId?: unknown }
    if (typeof manifest.candidateId !== 'string' || manifest.candidateId.length === 0) {
      throw new Error('gate5 runner: prebuilt capsule candidate identity missing')
    }
    const packed = await packAcpBinaryArchive(
      join(prebuiltCapsuleRoot, 'runtime'),
      join(workDir, 'dsh-self-evolving-acp.tar.gz'),
    )
    return { receipt: { candidateId: manifest.candidateId }, packed }
  }
  const receipt = await buildCandidate({ sourceRoot: candidateRoot, sourceFiles, tscBin })
  const capsuleDir = join(workDir, 'capsule')
  await packCapsule({
    outDir: capsuleDir,
    receipt,
    runnerOverlay: [
      '- id: deepseek-responses',
      "  name: '@dsh-self-evolving/llm-responses'",
      '  config:',
      '    apiKeyEnv: DEEPSEEK_API_KEY',
      '    reasoningEffort: high',
      `    maxTokens: ${maxTokens}`,
      `    contextWindow: ${contextWindow}`,
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
      `    candidateId: ${receipt.candidateId}`,
      '    mode: solve',
      '',
    ].join('\n'),
    provenanceJson: JSON.stringify({
      dshCommit: '47f943859bef60e4160492346772ded9b24f765a',
      model: targetModel,
      effectiveModel,
      reasoningEffort: 'high',
      contextWindow,
      maxTokens,
    }),
    sbomJson: JSON.stringify({ spdxVersion: 'SPDX-2.3' }),
    runnerFiles: {
      'credential-launcher.sh': [
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
      ].join('\n'),
    },
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
  await chmod(join(capsuleDir, 'runtime', 'credential-launcher.sh'), 0o755)
  const packed = await packAcpBinaryArchive(
    join(capsuleDir, 'runtime'),
    join(workDir, 'dsh-self-evolving-acp.tar.gz'),
  )
  return { receipt, packed }
}

async function collectRun(input: {
  runDir: string
  runId: string
  plannedTrials: number
  candidateIdHint?: string
  capsuleSha256?: string
  wallSec: number | null
}) {
  const jobDir = join(input.runDir, 'jobs', input.runId)
  const entries = await readdir(jobDir, { withFileTypes: true })
  const trialDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.includes('__'))
    .map((entry) => join(jobDir, entry.name))
    .sort()
  if (trialDirs.length !== input.plannedTrials) {
    throw new Error(`reconcile: trial matrix incomplete ${trialDirs.length}/${input.plannedTrials}`)
  }
  const normalized = []
  const candidateIds = new Set<string>()
  const attemptsByTask = new Map<string, number>()
  for (const trialDir of trialDirs) {
    const result = await stat(join(trialDir, 'result.json')).catch(() => null)
    if (result?.isFile() !== true)
      throw new Error(`reconcile: terminal result missing: ${trialDir}`)
    const configRaw = JSON.parse(await readFile(join(trialDir, 'config.json'), 'utf8')) as {
      task: { path: string }
    }
    const taskId = configRaw.task.path.split('/').at(-1) ?? configRaw.task.path
    const attemptIndex = attemptsByTask.get(taskId) ?? 0
    attemptsByTask.set(taskId, attemptIndex + 1)
    const attributionPath = join(trialDir, 'attribution.json')
    let attribution = await readFile(attributionPath, 'utf8').catch(() => null)
    if (attribution === null) {
      if (input.candidateIdHint === undefined) {
        throw new Error(`reconcile: attribution missing: ${trialDir}`)
      }
      attribution =
        JSON.stringify({ candidate_id: input.candidateIdHint, attempt_index: attemptIndex }) + '\n'
      await writeFile(attributionPath, attribution, { flag: 'wx' })
    }
    const parsed = JSON.parse(attribution) as {
      candidate_id?: unknown
      attempt_index?: unknown
    }
    if (typeof parsed.candidate_id !== 'string' || !Number.isSafeInteger(parsed.attempt_index)) {
      throw new Error(`reconcile: attribution invalid: ${trialDir}`)
    }
    candidateIds.add(parsed.candidate_id)
    const record = await normalizeTrial({
      trialDir,
      expectedCandidateId: parsed.candidate_id,
      taskId,
      requireAcpEvidence: true,
    })
    const usage = await readDshUsage(trialDir).catch(() => null)
    normalized.push({
      ...record,
      usage,
      costUsd: usage === null ? 0 : priceUsage(usage),
      priced: usage !== null,
    })
  }
  if (candidateIds.size !== 1) throw new Error('reconcile: candidate attribution is not unique')
  const candidateId = [...candidateIds][0]!
  const summary = {
    schemaVersion: 1,
    runId: input.runId,
    capabilityMode: 'real-official-responses-harbor-acp',
    candidateId,
    capsuleSha256: input.capsuleSha256 ?? null,
    route: {
      requestedModel: targetModel,
      effectiveModel,
      reasoningEffort: 'high',
      contextWindow,
      maxTokens,
      wireApi: 'responses',
    },
    officialPricing,
    plannedTrials: input.plannedTrials,
    collectedTrials: normalized.length,
    wallSec: input.wallSec,
    reconciledFromTerminalRaw: input.candidateIdHint === undefined,
    normalized,
  }
  const summaryBytes = JSON.stringify(summary, null, 2) + '\n'
  await writeFile(join(input.runDir, 'summary.json'), summaryBytes, { mode: 0o600, flag: 'wx' })
  const output = {
    runId: input.runId,
    candidateId,
    capsuleSha256: summary.capsuleSha256,
    plannedTrials: summary.plannedTrials,
    collectedTrials: summary.collectedTrials,
    statuses: normalized.map((row) => row.status),
    wallSec: input.wallSec,
    summaryHash: `sha256:${createHash('sha256').update(summaryBytes).digest('hex')}`,
    runDir: input.runDir,
  }
  process.stdout.write(JSON.stringify(output) + '\n')
  return summary
}

async function main(): Promise<void> {
  const runId = process.env['GATE5_RUN_ID'] ?? 'gate5-real-smoke-v1'
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(runId)) throw new Error('unsafe run id')
  const taskIds = (process.env['GATE5_TASK_IDS'] ?? 'fix-git')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const attempts = Number(process.env['GATE5_ATTEMPTS'] ?? '1')
  const concurrency = Number(process.env['GATE5_CONCURRENCY'] ?? '1')
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error('attempts must be 1 through 10')
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('concurrency must be 1 through 16')
  }
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
  if ((await stat(runDir).catch(() => null)) !== null) {
    const summaryPath = join(runDir, 'summary.json')
    const existing = await readFile(summaryPath, 'utf8').catch(() => null)
    if (existing !== null) {
      process.stdout.write(existing)
      return
    }
    await collectRun({ runDir, runId, plannedTrials: taskIds.length * attempts, wallSec: null })
    return
  }
  const route = await loadTrustedRoute()
  await mkdir(runDir, { recursive: false, mode: 0o700 })
  const workDir = await mkdtemp(join(tmpdir(), `${runId}-`))
  const { receipt, packed } = await buildBaselineRuntime(workDir)
  const artifact = await startArtifactServer(packed.archivePath, runDir)
  const secretDir = await mkdtemp('/run/dsh-self-evolving-gate5-secret-')
  await chmod(secretDir, 0o700)
  const secretPath = join(secretDir, 'provider.secret')
  await writeFile(secretPath, route.apiKey, { mode: 0o600, flag: 'wx' })
  try {
    const registry = buildRegistryEntry({
      candidateId: receipt.candidateId,
      agentName: 'dsh-self-evolving-gate5-baseline',
      version: receipt.candidateId,
      archiveUrl: artifact.url,
      archiveSha256: packed.sha256,
      cmd: './credential-launcher.sh',
      env: { DSH_SELF_EVOLVING_PROVIDER_SECRET_FILE: '/run/dsh-self-evolving/provider.secret' },
    })
    const maxAgentTimeout = Math.max(...tasks.map((task) => task.agentTimeoutSec))
    const config = buildJobConfig({
      jobName: runId,
      registryEntry: registry,
      modelName: '',
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        path: join(tb21Dir, task.taskId),
      })),
      nAttempts: attempts,
      nConcurrentTrials: concurrency,
      verifier: { timeoutSec: maxAgentTimeout, agentTimeoutSec: maxAgentTimeout },
      idempotencyKey: `gate5/${runId}/${receipt.candidateId}`,
      jobsDir: join(runDir, 'jobs'),
      environment: {
        env: { CURL_CA_BUNDLE: '/run/dsh-self-evolving/artifact-ca-bundle.crt' },
        mounts: [
          {
            type: 'bind',
            source: artifact.caBundlePath,
            target: '/run/dsh-self-evolving/artifact-ca-bundle.crt',
            read_only: true,
          },
          {
            type: 'bind',
            source: secretPath,
            target: '/run/dsh-self-evolving/provider.secret',
            read_only: true,
          },
        ],
      },
    })
    const configPath = join(runDir, 'job.yaml')
    const yaml = jobConfigToYaml(config)
    if (yaml.includes(route.apiKey)) throw new Error('credential leaked into persisted config')
    await writeFile(configPath, yaml, { mode: 0o600, flag: 'wx' })
    const startedAt = Date.now()
    await execResult(harborBin, ['job', 'start', '-c', configPath], {
      cwd: harborDir,
      env: process.env,
    })
    const wallSec = (Date.now() - startedAt) / 1000
    await collectRun({
      runDir,
      runId,
      plannedTrials: taskIds.length * attempts,
      candidateIdHint: receipt.candidateId,
      capsuleSha256: packed.sha256,
      wallSec,
    })
  } finally {
    await new Promise<void>((done, reject) =>
      artifact.server.close((error) => (error ? reject(error) : done())),
    )
    await rm(secretDir, { recursive: true })
  }
}

await main()
